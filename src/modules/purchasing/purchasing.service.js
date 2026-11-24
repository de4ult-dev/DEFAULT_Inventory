const PurchaseOrder = require('./purchaseOrder');
const Supplier = require('../suppliers');
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
 * Stage 1: Container Order (`PO-...`) in USD.
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
 * Stage 2: Container Receipt (`CNT-...`) from an existing PO (`AWAITING_RECEIPT`).
 * Adds customs/transport arrival costs (paid from cashbox if cashboxId is provided),
 * calculates landed cost per unit, and increases stock via receiveStock.
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
        if (po.status === 'RECEIVED') {
            const err = new Error(`Container order ${po.number} has already been received.`);
            err.statusCode = 400;
            throw err;
        }

        const sourceItems = items && items.length > 0 ? items : po.items;
        const { prepared, goodsAmount } = await preparePurchaseItems(sourceItems, 'USD', session);

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

        // Optional cashbox payout for arrival costs
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

        // Distribute extra arrival costs proportionally by goodsAmount share (converted to USD if in Kz)
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

        for (const entry of prepared) {
            const share = goodsTotalDec.gt(0)
                ? toDecimal(entry.lineTotal).div(goodsTotalDec)
                : toDecimal(1).div(prepared.length);
            const itemExtraUsd = extraInUsdDec.times(share);
            const itemTotalUsd = toDecimal(entry.lineTotal).plus(itemExtraUsd);
            const landedUnitCostUsd = itemTotalUsd.div(entry.quantity).toDecimalPlaces(4).toNumber();

            // If product currency is Kz, convert landed unit cost to Kz with manual rate if provided
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

            await receiveStock(
                {
                    productId: entry.product._id,
                    quantity: entry.quantity,
                    unitCost: stockCost,
                    currency: stockCurrency,
                    stockBucket: 'AVAILABLE',
                    referenceType: 'CONTAINER',
                    referenceNumber: receiptNumber,
                    reason: notes || `Container receipt ${receiptNumber} (PO ${po.number})`,
                    performedBy,
                    date,
                },
                session
            );

            finalItems.push({
                productId: entry.productId,
                skuSnapshot: entry.skuSnapshot,
                nameSnapshot: entry.nameSnapshot,
                quantity: entry.quantity,
                unitCost: entry.unitCost,
                currency: entry.currency,
                lineTotal: entry.lineTotal,
                landedUnitCost: stockCost,
                landedCurrency: stockCurrency,
            });
        }

        po.status = 'RECEIVED';
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
                before: { poNumber: po.number, status: 'AWAITING_RECEIPT' },
                after: {
                    receiptNumber: receiptDoc.number,
                    poStatus: po.status,
                    goodsAmount,
                    additionalCosts: receiptDoc.additionalCosts,
                },
                performedBy,
                timestamp: date,
            },
            session
        );

        return { receipt: receiptDoc, order: po };
    });
}

/**
 * Local Purchase (`LP-...`) in Kz.
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

module.exports = {
    createContainerOrder,
    receiveContainer,
    createLocalPurchase,
};