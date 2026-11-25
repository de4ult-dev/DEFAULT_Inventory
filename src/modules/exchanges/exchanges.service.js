const ProductExchange = require('./productExchange');
const Customer = require('../customers/customer');
const Product = require('../inventory/product');
const { receiveStock, deductStock } = require('../inventory/inventory.service');
const { convertWithManualRate } = require('../collections/collections.service');
const { runInTransaction } = require('../../shared/utils/transaction');
const { mulMoney, toDecimal } = require('../../shared/utils/money');
const { getNextSequence } = require('../../shared/services/sequence.service');
const { logAudit } = require('../../shared/services/audit.service');

const VALID_BUCKETS = ['AVAILABLE', 'DAMAGED'];

function normalizeBucket(bucket, fallback = 'AVAILABLE') {
    const val = bucket ? String(bucket).trim().toUpperCase() : fallback;
    if (!VALID_BUCKETS.includes(val)) {
        const err = new Error(`Invalid stock bucket: ${bucket}`);
        err.statusCode = 400;
        throw err;
    }
    return val;
}

/**
 * Value-neutral Product Exchange (`EX-...`).
 * Deducts outgoing product stock and receives incoming product stock
 * without creating invoices, cash movements, or changing customer/supplier balances.
 */
async function createProductExchange({
    customerId = null,
    outgoing,
    incoming,
    exchangeRate = null,
    reason = '',
    performedBy = null,
    date = new Date(),
}) {
    if (!outgoing || !outgoing.productId || !incoming || !incoming.productId) {
        const err = new Error('Both outgoing and incoming product details are required.');
        err.statusCode = 400;
        throw err;
    }

    const outQtyDec = toDecimal(outgoing.quantity);
    const inQtyDec = toDecimal(incoming.quantity);
    if (outQtyDec.lte(0) || inQtyDec.lte(0)) {
        const err = new Error('Outgoing and incoming quantities must be greater than zero.');
        err.statusCode = 400;
        throw err;
    }

    const outBucket = normalizeBucket(outgoing.stockBucket, 'AVAILABLE');
    const inBucket = normalizeBucket(incoming.stockBucket, 'AVAILABLE');

    return runInTransaction(async (session) => {
        let customer = null;
        if (customerId) {
            customer = await Customer.findById(customerId).session(session);
            if (!customer) {
                const err = new Error('Customer not found.');
                err.statusCode = 404;
                throw err;
            }
            if (customer.isActive === false) {
                const err = new Error(`Customer "${customer.name}" is inactive.`);
                err.statusCode = 400;
                throw err;
            }
        }

        const outProduct = await Product.findById(outgoing.productId).session(session);
        const inProduct = await Product.findById(incoming.productId).session(session);
        if (!outProduct || !inProduct) {
            const err = new Error('Outgoing or incoming product not found.');
            err.statusCode = 404;
            throw err;
        }

        const number = await getNextSequence('PRODUCT_EXCHANGE', 'EX', session);

        const cleanOutQty = outQtyDec.toDecimalPlaces(6).toNumber();
        const cleanInQty = inQtyDec.toDecimalPlaces(6).toNumber();

        const outUnitCost =
            outgoing.unitCost !== undefined && outgoing.unitCost !== null
                ? toDecimal(outgoing.unitCost).toDecimalPlaces(4).toNumber()
                : toDecimal(outProduct.cost).toDecimalPlaces(4).toNumber();
        const outTotalValue = mulMoney(cleanOutQty, outUnitCost, 2);

        let inUnitCost;
        let rateUsed = exchangeRate ? toDecimal(exchangeRate).toDecimalPlaces(6).toNumber() : 1;

        if (incoming.unitCost !== undefined && incoming.unitCost !== null) {
            inUnitCost = toDecimal(incoming.unitCost).toDecimalPlaces(4).toNumber();
        } else if (outProduct.currency === inProduct.currency) {
            inUnitCost = toDecimal(outTotalValue).div(cleanInQty).toDecimalPlaces(4).toNumber();
        } else {
            const convTotal = convertWithManualRate(
                outTotalValue,
                outProduct.currency,
                inProduct.currency,
                exchangeRate,
                4
            );
            rateUsed = convTotal.rateUsed;
            inUnitCost = toDecimal(convTotal.convertedAmount).div(cleanInQty).toDecimalPlaces(4).toNumber();
        }

        const inTotalValue = mulMoney(cleanInQty, inUnitCost, 2);

        const outRes = await deductStock(
            {
                productId: outProduct._id,
                quantity: cleanOutQty,
                unitCost: outUnitCost,
                currency: outProduct.currency,
                stockBucket: outBucket,
                referenceType: 'ADJUSTMENT',
                referenceNumber: number,
                reason: reason || `Product exchange out (${number})`,
                performedBy,
                date,
            },
            session
        );

        const inRes = await receiveStock(
            {
                productId: inProduct._id,
                quantity: cleanInQty,
                unitCost: inUnitCost,
                currency: inProduct.currency,
                stockBucket: inBucket,
                referenceType: 'ADJUSTMENT',
                referenceNumber: number,
                reason: reason || `Product exchange in (${number})`,
                performedBy,
                date,
            },
            session
        );

        const [exchangeDoc] = await ProductExchange.create(
            [
                {
                    number,
                    status: 'POSTED',
                    customerId: customer ? customer._id : null,
                    customerNameSnapshot: customer ? customer.name : '',
                    outgoing: {
                        productId: outProduct._id,
                        skuSnapshot: outProduct.sku,
                        nameSnapshot: outProduct.name,
                        stockBucket: outBucket,
                        quantity: cleanOutQty,
                        unitCost: outUnitCost,
                        currency: outProduct.currency,
                        totalValue: outTotalValue,
                    },
                    incoming: {
                        productId: inProduct._id,
                        skuSnapshot: inProduct.sku,
                        nameSnapshot: inProduct.name,
                        stockBucket: inBucket,
                        quantity: cleanInQty,
                        unitCost: inUnitCost,
                        currency: inProduct.currency,
                        totalValue: inTotalValue,
                    },
                    exchangeRate: rateUsed,
                    reason,
                    date,
                    createdBy: performedBy,
                },
            ],
            { session }
        );

        await logAudit(
            {
                entityType: 'ProductExchange',
                entityId: exchangeDoc._id,
                entityNumber: exchangeDoc.number,
                action: 'CREATE',
                reason: reason || `Product exchange ${exchangeDoc.number}`,
                before: null,
                after: {
                    number: exchangeDoc.number,
                    status: exchangeDoc.status,
                    outgoing: exchangeDoc.outgoing,
                    incoming: exchangeDoc.incoming,
                    exchangeRate: exchangeDoc.exchangeRate,
                },
                performedBy,
                timestamp: date,
            },
            session
        );

        return {
            exchange: exchangeDoc,
            outgoingProduct: outRes.product,
            incomingProduct: inRes.product,
            customer,
        };
    });
}

/**
 * Reverses a posted Product Exchange (`EX-...`) by returning outgoing stock
 * and deducting incoming stock inside a transaction with audit logging.
 */
async function cancelProductExchange({
    exchangeId,
    reason = '',
    performedBy = null,
    date = new Date(),
}) {
    if (!exchangeId) {
        const err = new Error('exchangeId is required.');
        err.statusCode = 400;
        throw err;
    }

    return runInTransaction(async (session) => {
        const exchangeDoc = await ProductExchange.findById(exchangeId).session(session);
        if (!exchangeDoc) {
            const err = new Error('Product exchange not found.');
            err.statusCode = 404;
            throw err;
        }
        if (exchangeDoc.status === 'CANCELLED') {
            const err = new Error(`Product exchange ${exchangeDoc.number} is already cancelled.`);
            err.statusCode = 400;
            throw err;
        }

        const cancelReason = reason || `Cancelled product exchange ${exchangeDoc.number}`;
        const outBucket = normalizeBucket(exchangeDoc.outgoing.stockBucket, 'AVAILABLE');
        const inBucket = normalizeBucket(exchangeDoc.incoming.stockBucket, 'AVAILABLE');

        const inReversal = await deductStock(
            {
                productId: exchangeDoc.incoming.productId,
                quantity: exchangeDoc.incoming.quantity,
                unitCost: exchangeDoc.incoming.unitCost,
                currency: exchangeDoc.incoming.currency,
                stockBucket: inBucket,
                referenceType: 'ADJUSTMENT',
                referenceNumber: exchangeDoc.number,
                reason: cancelReason,
                performedBy,
                date,
            },
            session
        );

        const outReversal = await receiveStock(
            {
                productId: exchangeDoc.outgoing.productId,
                quantity: exchangeDoc.outgoing.quantity,
                unitCost: exchangeDoc.outgoing.unitCost,
                currency: exchangeDoc.outgoing.currency,
                stockBucket: outBucket,
                referenceType: 'ADJUSTMENT',
                referenceNumber: exchangeDoc.number,
                reason: cancelReason,
                performedBy,
                date,
            },
            session
        );

        const beforeSnapshot = { status: exchangeDoc.status };
        exchangeDoc.status = 'CANCELLED';
        await exchangeDoc.save({ session });

        await logAudit(
            {
                entityType: 'ProductExchange',
                entityId: exchangeDoc._id,
                entityNumber: exchangeDoc.number,
                action: 'CANCEL',
                reason: cancelReason,
                before: beforeSnapshot,
                after: { status: exchangeDoc.status },
                performedBy,
                timestamp: date,
            },
            session
        );

        return {
            exchange: exchangeDoc,
            outgoingProduct: outReversal.product,
            incomingProduct: inReversal.product,
        };
    });
}

module.exports = {
    createProductExchange,
    cancelProductExchange,
};