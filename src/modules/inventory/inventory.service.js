const Product = require('./product');
const StockMove = require('./stockMove');
const { runInTransaction } = require('../../shared/utils/transaction');
const { addMoney, subMoney, mulMoney, toDecimal } = require('../../shared/utils/money');
const {
    assertValidCurrency,
    assertSameCurrency,
    assertSufficientStock,
} = require('../../shared/utils/guards');
const { getNextSequence } = require('../../shared/services/sequence.service');
const { logAudit } = require('../../shared/services/audit.service');

function computeMovingAverageCost(prevQty, prevCost, addedQty, addedUnitCost) {
    const qPrev = toDecimal(prevQty);
    const cPrev = toDecimal(prevCost);
    const qAdd = toDecimal(addedQty);
    const cAdd = toDecimal(addedUnitCost);

    const totalQty = qPrev.plus(qAdd);
    if (totalQty.lte(0)) {
        return 0;
    }

    const totalValue = qPrev.times(cPrev).plus(qAdd.times(cAdd));
    return totalValue.div(totalQty).toDecimalPlaces(4).toNumber();
}

/**
 * Adds stock (IN) to AVAILABLE or DAMAGED bucket strictly in the product's currency ('USD' or 'Kz').
 * Updates moving average unit cost when receiving into AVAILABLE stock.
 */
async function receiveStock(
    {
        productId,
        quantity,
        unitCost = 0,
        currency,
        stockBucket = 'AVAILABLE',
        referenceType = 'PURCHASE',
        referenceId = null,
        referenceNumber = '',
        reason = '',
        allowInactiveProduct = false,
        performedBy = null,
        date = new Date(),
    },
    externalSession = null
) {
    if (!['AVAILABLE', 'DAMAGED'].includes(stockBucket)) {
        const err = new Error(`Invalid stock bucket: ${stockBucket}`);
        err.statusCode = 400;
        throw err;
    }

    const qtyDec = toDecimal(quantity);
    if (qtyDec.lte(0)) {
        const err = new Error('Quantity must be greater than zero.');
        err.statusCode = 400;
        throw err;
    }

    const costDec = toDecimal(unitCost);
    if (costDec.lt(0)) {
        const err = new Error('Unit cost cannot be negative.');
        err.statusCode = 400;
        throw err;
    }

    const execute = async (session) => {
        const product = await Product.findById(productId).session(session);
        if (!product) {
            const err = new Error('Product not found.');
            err.statusCode = 404;
            throw err;
        }

        if (product.isActive === false && !allowInactiveProduct) {
            const err = new Error(`Product "${product.sku}" is inactive.`);
            err.statusCode = 400;
            throw err;
        }

        assertValidCurrency(product.currency, `product ${product.sku}`);
        if (currency) {
            assertSameCurrency(product.currency, currency, `stock receipt (${product.sku})`);
        }

        const beforeSnapshot = {
            available: product.stock.available,
            damaged: product.stock.damaged,
            cost: product.cost,
            currency: product.currency,
        };

        const cleanQty = qtyDec.toDecimalPlaces(6).toNumber();
        const effectiveUnitCost = costDec.toDecimalPlaces(4).toNumber();
        const totalCost = mulMoney(cleanQty, effectiveUnitCost, 4);

        if (stockBucket === 'AVAILABLE') {
            product.cost = computeMovingAverageCost(
                product.stock.available,
                product.cost,
                cleanQty,
                effectiveUnitCost
            );
            product.stock.available = addMoney(product.stock.available, cleanQty, 6);
        } else {
            product.stock.damaged = addMoney(product.stock.damaged, cleanQty, 6);
        }

        await product.save({ session });

        const [move] = await StockMove.create(
            [
                {
                    productId: product._id,
                    direction: 'IN',
                    stockBucket,
                    quantity: cleanQty,
                    unitCost: effectiveUnitCost,
                    totalCost,
                    currency: product.currency,
                    referenceType,
                    referenceId,
                    referenceNumber,
                    reason: reason || `IN ${stockBucket} (${referenceType})`,
                    performedBy,
                    date,
                },
            ],
            { session }
        );

        await logAudit(
            {
                entityType: 'StockMove',
                entityId: move._id,
                entityNumber: referenceNumber || String(move._id),
                action: 'CREATE',
                reason: reason || `Stock IN to ${stockBucket}`,
                before: beforeSnapshot,
                after: {
                    available: product.stock.available,
                    damaged: product.stock.damaged,
                    cost: product.cost,
                    currency: product.currency,
                    stockMoveId: move._id,
                },
                performedBy,
                timestamp: date,
            },
            session
        );

        return { product, stockMove: move };
    };

    if (externalSession) {
        return execute(externalSession);
    }

    return runInTransaction(execute);
}

/**
 * Deducts stock (OUT) from AVAILABLE or DAMAGED bucket strictly in the product's currency.
 */
async function deductStock(
    {
        productId,
        quantity,
        unitCost = null,
        currency,
        stockBucket = 'AVAILABLE',
        referenceType = 'INVOICE',
        referenceId = null,
        referenceNumber = '',
        reason = '',
        allowInactiveProduct = false,
        performedBy = null,
        date = new Date(),
    },
    externalSession = null
) {
    if (!['AVAILABLE', 'DAMAGED'].includes(stockBucket)) {
        const err = new Error(`Invalid stock bucket: ${stockBucket}`);
        err.statusCode = 400;
        throw err;
    }

    const qtyDec = toDecimal(quantity);
    if (qtyDec.lte(0)) {
        const err = new Error('Quantity must be greater than zero.');
        err.statusCode = 400;
        throw err;
    }

    const execute = async (session) => {
        const product = await Product.findById(productId).session(session);
        if (!product) {
            const err = new Error('Product not found.');
            err.statusCode = 404;
            throw err;
        }

        if (product.isActive === false && !allowInactiveProduct) {
            const err = new Error(`Product "${product.sku}" is inactive.`);
            err.statusCode = 400;
            throw err;
        }

        assertValidCurrency(product.currency, `product ${product.sku}`);
        if (currency) {
            assertSameCurrency(product.currency, currency, `stock deduction (${product.sku})`);
        }

        const beforeSnapshot = {
            available: product.stock.available,
            damaged: product.stock.damaged,
            cost: product.cost,
            currency: product.currency,
        };

        const cleanQty = qtyDec.toDecimalPlaces(6).toNumber();
        const bucketField = stockBucket === 'AVAILABLE' ? 'available' : 'damaged';
        const currentBucketQty = product.stock[bucketField];

        assertSufficientStock(currentBucketQty, cleanQty, `${product.sku} [${stockBucket}]`);

        product.stock[bucketField] = subMoney(currentBucketQty, cleanQty, 6);
        await product.save({ session });

        const effectiveUnitCost =
            unitCost !== null && unitCost !== undefined
                ? toDecimal(unitCost).toDecimalPlaces(4).toNumber()
                : product.cost;
        const totalCost = mulMoney(cleanQty, effectiveUnitCost, 4);

        const [move] = await StockMove.create(
            [
                {
                    productId: product._id,
                    direction: 'OUT',
                    stockBucket,
                    quantity: cleanQty,
                    unitCost: effectiveUnitCost,
                    totalCost,
                    currency: product.currency,
                    referenceType,
                    referenceId,
                    referenceNumber,
                    reason: reason || `OUT from ${stockBucket} (${referenceType})`,
                    performedBy,
                    date,
                },
            ],
            { session }
        );

        await logAudit(
            {
                entityType: 'StockMove',
                entityId: move._id,
                entityNumber: referenceNumber || String(move._id),
                action: 'POST',
                reason: reason || `Stock OUT from ${stockBucket}`,
                before: beforeSnapshot,
                after: {
                    available: product.stock.available,
                    damaged: product.stock.damaged,
                    cost: product.cost,
                    currency: product.currency,
                    stockMoveId: move._id,
                },
                performedBy,
                timestamp: date,
            },
            session
        );

        return { product, stockMove: move };
    };

    if (externalSession) {
        return execute(externalSession);
    }

    return runInTransaction(execute);
}

/**
 * Reclassifies stock between AVAILABLE and DAMAGED buckets atomically while preserving
 * the product's currency and moving average unit cost.
 */
async function reclassifyDamagedStock({
    productId,
    quantity,
    direction = 'TO_DAMAGED',
    reason = '',
    performedBy = null,
    date = new Date(),
}) {
    if (!['TO_DAMAGED', 'TO_AVAILABLE'].includes(direction)) {
        const err = new Error(`Invalid reclassification direction: ${direction}`);
        err.statusCode = 400;
        throw err;
    }

    const qtyDec = toDecimal(quantity);
    if (qtyDec.lte(0)) {
        const err = new Error('Quantity must be greater than zero.');
        err.statusCode = 400;
        throw err;
    }

    return runInTransaction(async (session) => {
        const product = await Product.findById(productId).session(session);
        if (!product) {
            const err = new Error('Product not found.');
            err.statusCode = 404;
            throw err;
        }

        assertValidCurrency(product.currency, `product ${product.sku}`);

        const refNumber = await getNextSequence('STOCK_ADJ', 'ADJ', session);
        const cleanQty = qtyDec.toDecimalPlaces(6).toNumber();

        const fromBucket = direction === 'TO_DAMAGED' ? 'AVAILABLE' : 'DAMAGED';
        const toBucket = direction === 'TO_DAMAGED' ? 'DAMAGED' : 'AVAILABLE';

        const outRes = await deductStock(
            {
                productId: product._id,
                quantity: cleanQty,
                unitCost: product.cost,
                currency: product.currency,
                stockBucket: fromBucket,
                referenceType: 'ADJUSTMENT',
                referenceId: product._id,
                referenceNumber: refNumber,
                reason: reason || `Reclassify ${cleanQty} from ${fromBucket} to ${toBucket}`,
                performedBy,
                date,
            },
            session
        );

        const inRes = await receiveStock(
            {
                productId: product._id,
                quantity: cleanQty,
                unitCost: product.cost,
                currency: product.currency,
                stockBucket: toBucket,
                referenceType: 'ADJUSTMENT',
                referenceId: product._id,
                referenceNumber: refNumber,
                reason: reason || `Reclassify ${cleanQty} from ${fromBucket} to ${toBucket}`,
                performedBy,
                date,
            },
            session
        );

        return {
            adjustmentNumber: refNumber,
            currency: product.currency,
            product: inRes.product,
            outMove: outRes.stockMove,
            inMove: inRes.stockMove,
        };
    });
}

/**
 * Fetches stock movement history (`StockMove`) for a product with optional filters.
 */
async function getProductStockLedger(
    productId,
    { from = null, to = null, stockBucket = null, limit = 200 } = {}
) {
    const product = await Product.findById(productId).lean();
    if (!product) {
        const err = new Error('Product not found.');
        err.statusCode = 404;
        throw err;
    }

    const query = { productId: product._id };
    if (stockBucket && ['AVAILABLE', 'DAMAGED'].includes(stockBucket)) {
        query.stockBucket = stockBucket;
    }
    if (from || to) {
        query.date = {};
        if (from) query.date.$gte = new Date(from);
        if (to) query.date.$lte = new Date(to);
    }

    const moves = await StockMove.find(query)
        .sort({ date: -1, createdAt: -1 })
        .limit(Number(limit) || 200)
        .lean();

    return {
        product,
        stock: product.stock,
        cost: product.cost,
        currency: product.currency,
        moves,
    };
}

/**
 * Computes total inventory valuation split by currency ('USD' and 'Kz')
 * across AVAILABLE and DAMAGED stock buckets.
 */
async function getInventoryValuation({ includeInactive = false } = {}) {
    const filter = includeInactive ? {} : { isActive: { $ne: false } };
    const products = await Product.find(filter).lean();

    let availableUsd = toDecimal(0);
    let availableKz = toDecimal(0);
    let damagedUsd = toDecimal(0);
    let damagedKz = toDecimal(0);

    for (const p of products) {
        const costDec = toDecimal(p.cost || 0);
        const availVal = toDecimal(p.stock?.available || 0).times(costDec);
        const dmgVal = toDecimal(p.stock?.damaged || 0).times(costDec);

        if (p.currency === 'USD') {
            availableUsd = availableUsd.plus(availVal);
            damagedUsd = damagedUsd.plus(dmgVal);
        } else {
            availableKz = availableKz.plus(availVal);
            damagedKz = damagedKz.plus(dmgVal);
        }
    }

    return {
        available: {
            usd: availableUsd.toDecimalPlaces(2).toNumber(),
            kz: availableKz.toDecimalPlaces(2).toNumber(),
        },
        damaged: {
            usd: damagedUsd.toDecimalPlaces(2).toNumber(),
            kz: damagedKz.toDecimalPlaces(2).toNumber(),
        },
        total: {
            usd: availableUsd.plus(damagedUsd).toDecimalPlaces(2).toNumber(),
            kz: availableKz.plus(damagedKz).toDecimalPlaces(2).toNumber(),
        },
        productsCount: products.length,
    };
}

module.exports = {
    computeMovingAverageCost,
    receiveStock,
    deductStock,
    reclassifyDamagedStock,
    getProductStockLedger,
    getInventoryValuation,
};