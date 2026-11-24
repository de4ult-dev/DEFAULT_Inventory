const ProductExchange = require('./productExchange');
const Customer = require('../customers');
const Product = require('../inventory/product');
const { receiveStock, deductStock } = require('../inventory/inventory.service');
const { convertWithManualRate } = require('../collections/collections.service');
const { runInTransaction } = require('../../shared/utils/transaction');
const { mulMoney, toDecimal } = require('../../shared/utils/money');
const { getNextSequence } = require('../../shared/services/sequence.service');
const { logAudit } = require('../../shared/services/audit.service');

/**
 * Value-neutral Product Exchange (`EX-...`).
 * Deducts outgoing product stock (`AVAILABLE`) and receives incoming product stock (`AVAILABLE`)
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

    return runInTransaction(async (session) => {
        let customer = null;
        if (customerId) {
            customer = await Customer.findById(customerId).session(session);
            if (!customer) {
                const err = new Error('Customer not found.');
                err.statusCode = 404;
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

        // Determine incoming unit cost in incoming product's currency
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
                stockBucket: outgoing.stockBucket || 'AVAILABLE',
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
                stockBucket: incoming.stockBucket || 'AVAILABLE',
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
                    customerId: customer ? customer._id : null,
                    customerNameSnapshot: customer ? customer.name : '',
                    outgoing: {
                        productId: outProduct._id,
                        skuSnapshot: outProduct.sku,
                        nameSnapshot: outProduct.name,
                        quantity: cleanOutQty,
                        unitCost: outUnitCost,
                        currency: outProduct.currency,
                        totalValue: outTotalValue,
                    },
                    incoming: {
                        productId: inProduct._id,
                        skuSnapshot: inProduct.sku,
                        nameSnapshot: inProduct.name,
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

module.exports = {
    createProductExchange,
};