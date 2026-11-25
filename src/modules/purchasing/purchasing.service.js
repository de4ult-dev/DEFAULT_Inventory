const PurchaseOrder = require('./purchaseOrder');
const Supplier = require('../suppliers/supplier');
const Product = require('../inventory/product');
const Cashbox = require('../treasury/cashbox');
const { receiveStock } = require('../inventory/inventory.service');
const { recordCashMovement } = require('../treasury/treasury.service');
const { convertWithManualRate } = require('../collections/collections.service');
const { runInTransaction } = require('../../shared/utils/transaction');
const { addMoney, mulMoney, toDecimal } = require('../../shared/utils/money');
const { assertValidCurrency } = require('../../shared/utils/guards');
const { getNextSequence } = require('../../shared/services/sequence.service');
const { logAudit } = require('../../shared/services/audit.service');

function normalizeCurrency(curr) {
    if (!curr) return curr;
    const trimmed = String(curr).trim();
    if (trimmed.toUpperCase() === 'USD') return 'USD';
    if (trimmed.toUpperCase() === 'KZ') return 'Kz';
    return trimmed;
}

async function preparePurchaseItems(rawItems, expectedCurrency, session) {
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
        const err = new Error('Purchase must contain at least one item.');
        err.statusCode = 400;
        throw err;
    }

    let goodsTotal = toDecimal(0);
    const prepared = [];

    for (const item of rawItems) {
        const qtyDec = toDecimal(item.quantity);
        if (qtyDec.lte(0)) {
            const err = new Error('Item quantity must be greater than zero.');
            err.statusCode = 400;
            throw err;
        }

        const costDec = toDecimal(item.unitCost);
        if (costDec.lt(0)) {
            const err = new Error('Item unitCost cannot be negative.');
            err.statusCode = 400;
            throw err;
        }

        const product = await Product.findById(item.productId).session(session);
        if (!product) {
            const err = new Error(`Product not found: ${item.productId}`);
            err.statusCode = 404;
            throw err;
        }

        const itemCurrency = normalizeCurrency(item.currency || expectedCurrency);
        assertValidCurrency(itemCurrency, `purchase item (${product.sku})`);
        if (itemCurrency !== expectedCurrency) {
            const err = new Error(
                `Item currency (${itemCurrency}) must match order currency (${expectedCurrency}) for ${product.sku}.`
            );
            err.statusCode = 400;
            throw err;
        }

        const cleanQty = qtyDec.toDecimalPlaces(6).toNumber();
        const cleanCost = costDec.toDecimalPlaces(4).toNumber();
        const lineTotal = mulMoney(cleanQty, cleanCost, 2);

        goodsTotal = goodsTotal.plus(lineTotal);
        prepared.push({
            product,
            productId: product._id,
            skuSnapshot: product.sku,
            nameSnapshot: product.name,
            quantity: cleanQty,
            unitCost: cleanCost,
            currency: itemCurrency,
            lineTotal,
            landedUnitCost: cleanCost,
            landedCurrency: itemCurrency,
        });
    }

    return {
        prepared,
        goodsAmount: goodsTotal.toDecimalPlaces(2).toNumber(),
    };
}

/**
 * Stage 1: Container Order (`PO-...`) in USD for an EXTERNAL supplier.
 * Records supplier liability in USD without changing stock.
 */
async function createContainerOrder({
    supplierId,
    items = [],
    notes = '',
    performedBy = null,
    date = new Date(),
}) {
    return runInTransaction(async (session) => {
        const supplier = await Supplier.findById(supplierId).session(session);
        if (!supplier) {
            const err = new Error('Supplier not found.');
            err.statusCode = 404;
            throw err;
        }
        if (!supplier.isActive) {
            const err = new Error(`Supplier "${supplier.name}" is inactive.`);
            err.statusCode = 400;
            throw err;
        }
        if (supplier.type !== 'EXTERNAL') {
            const err = new Error(
                `Container orders (PO) are allowed only for EXTERNAL suppliers. Supplier "${supplier.name}" is ${supplier.type}.`
            );
            err.statusCode = 400;
            throw err;
        }

        const { prepared, goodsAmount } = await preparePurchaseItems(items, 'USD', session);
        const number = await getNextSequence('CONTAINER_ORDER', 'PO', session);

        supplier.balances.usd = addMoney(supplier.balances.usd, goodsAmount, 2);
        await supplier.save({ session });

        const [orderDoc] = await PurchaseOrder.create(
            [
                {
                    number,
                    type: 'CONTAINER_ORDER',
                    supplierId: supplier._id,
                    supplierNameSnapshot: supplier.name,
                    currency: 'USD',
                    status: 'AWAITING_RECEIPT',
                    items: prepared.map(({ product, ...rest }) => ({
                        ...rest,
                        receivedQuantity: 0,
                    })),
                    goodsAmount,
                    totalAmount: goodsAmount,
                    date,
                    notes,
                    createdBy: performedBy,
                },
            ],
            { session }
        );

        await logAudit(
            {
                entityType: 'PurchaseOrder',
                entityId: orderDoc._id,
                entityNumber: orderDoc.number,
                action: 'CREATE',
                reason: notes || `Created container order ${orderDoc.number}`,
                before: null,
                after: {
                    number: orderDoc.number,
                    type: orderDoc.type,
                    status: orderDoc.status,
                    totalAmount: orderDoc.totalAmount,
                    currency: orderDoc.currency,
                },
                performedBy,
                timestamp: date,
            },
            session
        );

        return { order: orderDoc, supplier };
    });
}

/**
 * Stage 2: Container Receipt (`CNT-...`) from an existing PO (`AWAITING_RECEIPT` or `PARTIAL`).
 * Supports partial receipts, validates items & remaining quantities against PO,
 * splits healthy (`AVAILABLE`) and damaged (`DAMAGED`) stock buckets,
 * adjusts supplier USD liability for quantity variances, and allocates arrival costs.
 */
async function receiveContainer({
    purchaseOrderId,
    items = null,
    additionalCosts = {},
    notes = '',
    performedBy = null,
    date = new Date(),
}) {
    return runInTransaction(async (session) => {
        const po = await PurchaseOrder.findById(purchaseOrderId).session(session);
        if (!po || po.type !== 'CONTAINER_ORDER') {
            const err = new Error('Container order (PO) not found.');
            err.statusCode = 404;
            throw err;
        }
        if (po.status === 'RECEIVED' || po.status === 'CANCELLED') {
            const err = new Error(`Container order ${po.number} cannot be received in status "${po.status}".`);
            err.statusCode = 400;
            throw err;
        }

        const supplier = await Supplier.findById(po.supplierId).session(session);
        if (!supplier) {
            const err = new Error('Supplier not found for container order.');
            err.statusCode = 404;
            throw err;
        }

        const poItemMap = new Map();
        for (const poItem of po.items) {
            const key = String(poItem.productId);
            const orderedQtyDec = toDecimal(poItem.quantity);
            const alreadyReceivedDec = toDecimal(poItem.receivedQuantity || 0);
            const remainingQtyDec = orderedQtyDec.minus(alreadyReceivedDec);
            poItemMap.set(key, {
                poItem,
                orderedQtyDec,
                alreadyReceivedDec,
                remainingQtyDec,
            });
        }

        const receiptInputs =
            Array.isArray(items) && items.length > 0
                ? items
                : po.items
                    .map((poItem) => {
                        const rem = toDecimal(poItem.quantity).minus(poItem.receivedQuantity || 0);
                        return {
                            productId: poItem.productId,
                            quantity: rem.toNumber(),
                            damagedQuantity: 0,
                            unitCost: poItem.unitCost,
                            currency: 'USD',
                        };
                    })
                    .filter((entry) => toDecimal(entry.quantity).gt(0));

        if (!receiptInputs.length) {
            const err = new Error('No remaining quantities available to receive for this container order.');
            err.statusCode = 400;
            throw err;
        }

        let receiptGoodsTotalDec = toDecimal(0);
        let orderedEquivalentTotalDec = toDecimal(0);
        const preparedBatch = [];

        for (const rawInput of receiptInputs) {
            const key = String(rawInput.productId);
            const entry = poItemMap.get(key);
            if (!entry) {
                const err = new Error(`Product ${rawInput.productId} is not part of container order ${po.number}.`);
                err.statusCode = 400;
                throw err;
            }

            const qtyDec = toDecimal(rawInput.quantity);
            if (qtyDec.lte(0)) {
                const err = new Error(`Receipt quantity must be greater than zero for product ${entry.poItem.skuSnapshot}.`);
                err.statusCode = 400;
                throw err;
            }

            if (qtyDec.gt(entry.remainingQtyDec)) {
                const err = new Error(
                    `Receipt quantity (${qtyDec.toNumber()}) exceeds remaining quantity (${entry.remainingQtyDec.toNumber()}) on PO ${po.number} for ${entry.poItem.skuSnapshot}.`
                );
                err.statusCode = 400;
                throw err;
            }

            const damagedDec = toDecimal(rawInput.damagedQuantity ?? rawInput.damagedQty ?? 0);
            if (damagedDec.lt(0) || damagedDec.gt(qtyDec)) {
                const err = new Error(
                    `Invalid damaged quantity (${damagedDec.toNumber()}) for ${entry.poItem.skuSnapshot}; must be between 0 and ${qtyDec.toNumber()}.`
                );
                err.statusCode = 400;
                throw err;
            }

            const availableDec = qtyDec.minus(damagedDec);
            const poUnitCostDec = toDecimal(entry.poItem.unitCost);
            const receiptUnitCostDec =
                rawInput.unitCost !== undefined && rawInput.unitCost !== null
                    ? toDecimal(rawInput.unitCost)
                    : poUnitCostDec;

            if (receiptUnitCostDec.lt(0)) {
                const err = new Error(`Unit cost cannot be negative for ${entry.poItem.skuSnapshot}.`);
                err.statusCode = 400;
                throw err;
            }

            const product = await Product.findById(entry.poItem.productId).session(session);
            if (!product) {
                const err = new Error(`Product not found: ${entry.poItem.productId}`);
                err.statusCode = 404;
                throw err;
            }

            const cleanQty = qtyDec.toDecimalPlaces(6).toNumber();
            const cleanAvailableQty = availableDec.toDecimalPlaces(6).toNumber();
            const cleanDamagedQty = damagedDec.toDecimalPlaces(6).toNumber();
            const cleanUnitCost = receiptUnitCostDec.toDecimalPlaces(4).toNumber();
            const lineTotal = mulMoney(cleanQty, cleanUnitCost, 2);
            const orderedLineTotal = mulMoney(cleanQty, poUnitCostDec.toDecimalPlaces(4).toNumber(), 2);

            receiptGoodsTotalDec = receiptGoodsTotalDec.plus(lineTotal);
            orderedEquivalentTotalDec = orderedEquivalentTotalDec.plus(orderedLineTotal);

            entry.poItem.receivedQuantity = entry.alreadyReceivedDec.plus(qtyDec).toDecimalPlaces(6).toNumber();

            preparedBatch.push({
                product,
                productId: product._id,
                skuSnapshot: entry.poItem.skuSnapshot,
                nameSnapshot: entry.poItem.nameSnapshot,
                quantity: cleanQty,
                availableQuantity: cleanAvailableQty,
                damagedQuantity: cleanDamagedQty,
                unitCost: cleanUnitCost,
                currency: 'USD',
                lineTotal,
            });
        }

        const goodsAmount = receiptGoodsTotalDec.toDecimalPlaces(2).toNumber();
        const orderedEquivalentAmount = orderedEquivalentTotalDec.toDecimalPlaces(2).toNumber();

        const varianceUsd = toDecimal(goodsAmount).minus(orderedEquivalentAmount).toDecimalPlaces(2).toNumber();
        if (varianceUsd !== 0) {
            supplier.balances.usd = addMoney(supplier.balances.usd, varianceUsd, 2);
            await supplier.save({ session });
        }

        const customsDec = toDecimal(additionalCosts.customs || 0);
        const transportDec = toDecimal(additionalCosts.transport || 0);
        const otherDec = toDecimal(additionalCosts.other || 0);
        if (customsDec.lt(0) || transportDec.lt(0) || otherDec.lt(0)) {
            const err = new Error('Arrival cost components cannot be negative.');
            err.statusCode = 400;
            throw err;
        }

        const extraTotalDec = customsDec.plus(transportDec).plus(otherDec);
        const extraCurrency = normalizeCurrency(additionalCosts.currency || 'Kz');
        assertValidCurrency(extraCurrency, 'arrival cost currency');

        const receiptNumber = await getNextSequence('CONTAINER_RECEIPT', 'CNT', session);

        let rateUsed = 1;
        if (extraTotalDec.gt(0) && additionalCosts.cashboxId) {
            const cashbox = await Cashbox.findById(additionalCosts.cashboxId).session(session);
            if (!cashbox) {
                const err = new Error('Arrival cost cashbox not found.');
                err.statusCode = 404;
                throw err;
            }

            const conv = convertWithManualRate(
                extraTotalDec,
                extraCurrency,
                cashbox.currency,
                additionalCosts.exchangeRate,
                2
            );
            rateUsed = conv.rateUsed;

            await recordCashMovement(
                {
                    cashboxId: cashbox._id,
                    direction: 'OUT',
                    amount: conv.convertedAmount,
                    currency: cashbox.currency,
                    category: 'CONTAINER_COST',
                    referenceType: 'CONTAINER',
                    referenceNumber: receiptNumber,
                    description: notes || `Arrival cost for container ${receiptNumber} (PO ${po.number})`,
                    reason: notes || `Container receipt ${receiptNumber}`,
                    performedBy,
                    date,
                },
                session
            );
        } else if (extraTotalDec.gt(0) && additionalCosts.exchangeRate) {
            rateUsed = toDecimal(additionalCosts.exchangeRate).toDecimalPlaces(6).toNumber();
        }

        let extraInUsdDec = toDecimal(0);
        if (extraTotalDec.gt(0)) {
            if (extraCurrency === 'USD') {
                extraInUsdDec = extraTotalDec;
            } else {
                const convToUsd = convertWithManualRate(
                    extraTotalDec,
                    'Kz',
                    'USD',
                    additionalCosts.exchangeRate,
                    6
                );
                extraInUsdDec = toDecimal(convToUsd.convertedAmount);
                rateUsed = convToUsd.rateUsed;
            }
        }

        const goodsTotalDec = toDecimal(goodsAmount);
        const finalItems = [];

        for (const entry of preparedBatch) {
            const share = goodsTotalDec.gt(0)
                ? toDecimal(entry.lineTotal).div(goodsTotalDec)
                : toDecimal(1).div(preparedBatch.length);
            const itemExtraUsd = extraInUsdDec.times(share);
            const itemTotalUsd = toDecimal(entry.lineTotal).plus(itemExtraUsd);
            const landedUnitCostUsd = itemTotalUsd.div(entry.quantity).toDecimalPlaces(4).toNumber();

            let stockCost = landedUnitCostUsd;
            let stockCurrency = 'USD';
            if (entry.product.currency === 'Kz') {
                const convCost = convertWithManualRate(
                    landedUnitCostUsd,
                    'USD',
                    'Kz',
                    additionalCosts.exchangeRate,
                    4
                );
                stockCost = convCost.convertedAmount;
                stockCurrency = 'Kz';
            }

            if (entry.availableQuantity > 0) {
                await receiveStock(
                    {
                        productId: entry.product._id,
                        quantity: entry.availableQuantity,
                        unitCost: stockCost,
                        currency: stockCurrency,
                        stockBucket: 'AVAILABLE',
                        referenceType: 'CONTAINER',
                        referenceNumber: receiptNumber,
                        reason: notes || `Container receipt ${receiptNumber} (PO ${po.number}) [AVAILABLE]`,
                        performedBy,
                        date,
                    },
                    session
                );
            }

            if (entry.damagedQuantity > 0) {
                await receiveStock(
                    {
                        productId: entry.product._id,
                        quantity: entry.damagedQuantity,
                        unitCost: stockCost,
                        currency: stockCurrency,
                        stockBucket: 'DAMAGED',
                        referenceType: 'CONTAINER',
                        referenceNumber: receiptNumber,
                        reason: notes || `Container receipt ${receiptNumber} (PO ${po.number}) [DAMAGED]`,
                        performedBy,
                        date,
                    },
                    session
                );
            }

            finalItems.push({
                productId: entry.productId,
                skuSnapshot: entry.skuSnapshot,
                nameSnapshot: entry.nameSnapshot,
                quantity: entry.quantity,
                availableQuantity: entry.availableQuantity,
                damagedQuantity: entry.damagedQuantity,
                unitCost: entry.unitCost,
                currency: entry.currency,
                lineTotal: entry.lineTotal,
                landedUnitCost: stockCost,
                landedCurrency: stockCurrency,
            });
        }

        const allReceived = po.items.every((poItem) =>
            toDecimal(poItem.receivedQuantity || 0).gte(poItem.quantity)
        );
        po.status = allReceived ? 'RECEIVED' : 'PARTIAL';
        await po.save({ session });

        const [receiptDoc] = await PurchaseOrder.create(
            [
                {
                    number: receiptNumber,
                    type: 'CONTAINER_RECEIPT',
                    parentOrderId: po._id,
                    supplierId: po.supplierId,
                    supplierNameSnapshot: po.supplierNameSnapshot,
                    currency: 'USD',
                    status: 'RECEIVED',
                    items: finalItems,
                    goodsAmount,
                    additionalCosts: {
                        customs: customsDec.toDecimalPlaces(2).toNumber(),
                        transport: transportDec.toDecimalPlaces(2).toNumber(),
                        other: otherDec.toDecimalPlaces(2).toNumber(),
                        currency: extraCurrency,
                        cashboxId: additionalCosts.cashboxId || null,
                        exchangeRate: rateUsed,
                    },
                    totalAmount: goodsAmount,
                    date,
                    notes,
                    createdBy: performedBy,
                },
            ],
            { session }
        );

        await logAudit(
            {
                entityType: 'PurchaseOrder',
                entityId: receiptDoc._id,
                entityNumber: receiptDoc.number,
                action: 'RECEIVE',
                reason: notes || `Received container ${receiptDoc.number} for PO ${po.number}`,
                before: { poNumber: po.number, status: po.status },
                after: {
                    receiptNumber: receiptDoc.number,
                    poStatus: po.status,
                    goodsAmount,
                    varianceUsd,
                    additionalCosts: receiptDoc.additionalCosts,
                },
                performedBy,
                timestamp: date,
            },
            session
        );

        return { receipt: receiptDoc, order: po, supplier };
    });
}

/**
 * Local Purchase (`LP-...`) in Kz for a LOCAL supplier.
 * Supports `DRAFT` (no stock/supplier liability impact yet) or `RECEIVED` (updates Kz stock & Kz supplier balance).
 */
async function createLocalPurchase({
    supplierId,
    items = [],
    status = 'RECEIVED',
    notes = '',
    performedBy = null,
    date = new Date(),
}) {
    const normalizedStatus = status === 'DRAFT' ? 'DRAFT' : 'RECEIVED';

    return runInTransaction(async (session) => {
        const supplier = await Supplier.findById(supplierId).session(session);
        if (!supplier) {
            const err = new Error('Supplier not found.');
            err.statusCode = 404;
            throw err;
        }
        if (!supplier.isActive) {
            const err = new Error(`Supplier "${supplier.name}" is inactive.`);
            err.statusCode = 400;
            throw err;
        }
        if (supplier.type !== 'LOCAL') {
            const err = new Error(
                `Local purchases (LP) are allowed only for LOCAL suppliers. Supplier "${supplier.name}" is ${supplier.type}.`
            );
            err.statusCode = 400;
            throw err;
        }

        const { prepared, goodsAmount } = await preparePurchaseItems(items, 'Kz', session);
        const number = await getNextSequence('LOCAL_PURCHASE', 'LP', session);

        if (normalizedStatus === 'RECEIVED') {
            for (const entry of prepared) {
                await receiveStock(
                    {
                        productId: entry.product._id,
                        quantity: entry.quantity,
                        unitCost: entry.unitCost,
                        currency: 'Kz',
                        stockBucket: 'AVAILABLE',
                        referenceType: 'PURCHASE',
                        referenceNumber: number,
                        reason: notes || `Local purchase ${number}`,
                        performedBy,
                        date,
                    },
                    session
                );
            }

            supplier.balances.kz = addMoney(supplier.balances.kz, goodsAmount, 2);
            await supplier.save({ session });
        }

        const [lpDoc] = await PurchaseOrder.create(
            [
                {
                    number,
                    type: 'LOCAL_PURCHASE',
                    supplierId: supplier._id,
                    supplierNameSnapshot: supplier.name,
                    currency: 'Kz',
                    status: normalizedStatus,
                    items: prepared.map(({ product, ...rest }) => rest),
                    goodsAmount,
                    totalAmount: goodsAmount,
                    date,
                    notes,
                    createdBy: performedBy,
                },
            ],
            { session }
        );

        await logAudit(
            {
                entityType: 'PurchaseOrder',
                entityId: lpDoc._id,
                entityNumber: lpDoc.number,
                action: 'CREATE',
                reason: notes || `Created local purchase ${lpDoc.number} (${normalizedStatus})`,
                before: null,
                after: {
                    number: lpDoc.number,
                    status: lpDoc.status,
                    totalAmount: lpDoc.totalAmount,
                    currency: 'Kz',
                },
                performedBy,
                timestamp: date,
            },
            session
        );

        return { purchase: lpDoc, supplier };
    });
}

/**
 * Replaces damaged stock (`DAMAGED` bucket) with healthy stock (`AVAILABLE` bucket) from a supplier.
 * Validates damaged balance, updates both stock buckets atomically, optionally adjusts supplier balance
 * for any price/cost difference, and logs an audit entry.
 */
async function replaceDamagedGoodsFromSupplier({
    supplierId,
    productId,
    quantity,
    replacementQuantity = null,
    unitCost = null,
    currency = null,
    exchangeRate = null,
    adjustSupplierBalance = false,
    reason = '',
    referenceNumber = '',
    performedBy = null,
    date = new Date(),
}) {
    return runInTransaction(async (session) => {
        if (!supplierId || !productId) {
            const err = new Error('supplierId and productId are required for damaged goods replacement.');
            err.statusCode = 400;
            throw err;
        }

        const damagedQtyDec = toDecimal(quantity);
        if (damagedQtyDec.lte(0)) {
            const err = new Error('Damaged quantity to replace must be greater than zero.');
            err.statusCode = 400;
            throw err;
        }

        const replacementQtyDec =
            replacementQuantity !== null && replacementQuantity !== undefined
                ? toDecimal(replacementQuantity)
                : damagedQtyDec;

        if (replacementQtyDec.lte(0)) {
            const err = new Error('Replacement healthy quantity must be greater than zero.');
            err.statusCode = 400;
            throw err;
        }

        const supplier = await Supplier.findById(supplierId).session(session);
        if (!supplier) {
            const err = new Error('Supplier not found.');
            err.statusCode = 404;
            throw err;
        }
        if (!supplier.isActive) {
            const err = new Error(`Supplier "${supplier.name}" is inactive.`);
            err.statusCode = 400;
            throw err;
        }

        const product = await Product.findById(productId).session(session);
        if (!product) {
            const err = new Error('Product not found.');
            err.statusCode = 404;
            throw err;
        }

        const currentDamagedDec = toDecimal(product.stock?.damaged || 0);
        const cleanDamagedQty = damagedQtyDec.toDecimalPlaces(6).toNumber();
        const cleanReplacementQty = replacementQtyDec.toDecimalPlaces(6).toNumber();

        if (currentDamagedDec.lt(damagedQtyDec)) {
            const err = new Error(
                `Insufficient DAMAGED stock for ${product.sku}. Available damaged: ${currentDamagedDec.toNumber()}, requested: ${cleanDamagedQty}.`
            );
            err.statusCode = 400;
            throw err;
        }

        assertValidCurrency(product.currency, `product ${product.sku}`);
        const targetCurr = currency ? normalizeCurrency(currency) : product.currency;
        assertValidCurrency(targetCurr, 'replacement cost currency');

        const baseCostDec =
            unitCost !== null && unitCost !== undefined ? toDecimal(unitCost) : toDecimal(product.cost || 0);
        if (baseCostDec.lt(0)) {
            const err = new Error('Unit cost cannot be negative.');
            err.statusCode = 400;
            throw err;
        }

        let productCostDec = baseCostDec;
        if (targetCurr !== product.currency) {
            const conv = convertWithManualRate(baseCostDec, targetCurr, product.currency, exchangeRate, 4);
            productCostDec = toDecimal(conv.convertedAmount);
        }

        const cleanProductCost = productCostDec.toDecimalPlaces(4).toNumber();
        const refNum = referenceNumber || `DMG-REP-${product.sku}`;
        const auditReason =
            reason || `Replaced ${cleanDamagedQty} damaged ${product.sku} with ${cleanReplacementQty} available from ${supplier.name}`;

        const currentAvailableDec = toDecimal(product.stock?.available || 0);
        const nextDamagedDec = currentDamagedDec.minus(damagedQtyDec);

        const prevQtyDec = currentAvailableDec;
        const nextAvailableDec = currentAvailableDec.plus(replacementQtyDec);
        const incomingValueDec = replacementQtyDec.times(productCostDec);
        const prevValueDec = prevQtyDec.times(toDecimal(product.cost || 0));

        const nextCost = nextAvailableDec.gt(0)
            ? prevValueDec.plus(incomingValueDec).div(nextAvailableDec).toDecimalPlaces(4).toNumber()
            : cleanProductCost;

        const beforeSnapshot = {
            productStock: {
                available: currentAvailableDec.toDecimalPlaces(6).toNumber(),
                damaged: currentDamagedDec.toDecimalPlaces(6).toNumber(),
                cost: toDecimal(product.cost || 0).toDecimalPlaces(4).toNumber(),
            },
            supplierBalances: { ...supplier.balances },
        };

        product.stock.damaged = nextDamagedDec.toDecimalPlaces(6).toNumber();
        product.stock.available = nextAvailableDec.toDecimalPlaces(6).toNumber();
        product.cost = nextCost;
        await product.save({ session });

        let balanceDelta = 0;
        if (adjustSupplierBalance) {
            const oldDamagedVal = damagedQtyDec.times(productCostDec);
            const newAvailVal = replacementQtyDec.times(productCostDec);
            const diffDec = newAvailVal.minus(oldDamagedVal);
            balanceDelta = diffDec.toDecimalPlaces(2).toNumber();

            if (balanceDelta !== 0) {
                const balKey = product.currency === 'USD' ? 'usd' : 'kz';
                supplier.balances[balKey] = addMoney(supplier.balances[balKey], balanceDelta, 2);
                await supplier.save({ session });
            }
        }

        await logAudit(
            {
                entityType: 'SupplierReplacement',
                entityId: product._id,
                entityNumber: refNum,
                action: 'REPLACE_DAMAGED',
                reason: auditReason,
                before: beforeSnapshot,
                after: {
                    supplierId: supplier._id,
                    supplierName: supplier.name,
                    productId: product._id,
                    sku: product.sku,
                    damagedRemoved: cleanDamagedQty,
                    availableAdded: cleanReplacementQty,
                    unitCost: cleanProductCost,
                    currency: product.currency,
                    balanceDelta,
                    productStock: {
                        available: product.stock.available,
                        damaged: product.stock.damaged,
                        cost: product.cost,
                    },
                    supplierBalances: supplier