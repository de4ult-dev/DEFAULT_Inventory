const ReturnInvoice = require('./returnInvoice');
const Customer = require('../customers/customer');
const Product = require('../inventory/product');
const Cashbox = require('../treasury/cashbox');
const { receiveStock } = require('../inventory/inventory.service');
const { recordCashMovement } = require('../treasury/treasury.service');
const { runInTransaction } = require('../../shared/utils/transaction');
const { addMoney, subMoney, mulMoney, toDecimal } = require('../../shared/utils/money');
const { assertValidCurrency, assertSameCurrency } = require('../../shared/utils/guards');
const { getNextSequence } = require('../../shared/services/sequence.service');
const { logAudit } = require('../../shared/services/audit.service');

function normalizeCurrency(curr) {
    if (!curr) return curr;
    const trimmed = String(curr).trim();
    if (trimmed.toUpperCase() === 'USD') return 'USD';
    if (trimmed.toUpperCase() === 'KZ') return 'Kz';
    return trimmed;
}

function hasCustomPricePermission({ allowCustomPrice = false, permissions = [], userRole = null }) {
    if (allowCustomPrice === true) return true;
    if (Array.isArray(permissions) && (permissions.includes('OVERRIDE_PRICE') || permissions.includes('SET_UNIT_PRICE'))) {
        return true;
    }
    if (userRole && ['ADMIN', 'MANAGER'].includes(String(userRole).toUpperCase())) {
        return true;
    }
    return false;
}

/**
 * Converts `amount` between USD and Kz using a manually entered `rate` (Kz per 1 USD).
 * - Same currency: returns amount unchanged (rate = 1)
 * - USD -> Kz: amount * rate
 * - Kz -> USD: amount / rate
 */
function convertWithManualRate(amount, fromCurrency, toCurrency, manualRate, decimals = 2) {
    const amtDec = toDecimal(amount);
    if (amtDec.lte(0)) {
        const err = new Error('Amount must be greater than zero.');
        err.statusCode = 400;
        throw err;
    }

    const from = normalizeCurrency(fromCurrency);
    const to = normalizeCurrency(toCurrency);
    assertValidCurrency(from, 'source currency');
    assertValidCurrency(to, 'target currency');

    if (from === to) {
        return {
            convertedAmount: amtDec.toDecimalPlaces(decimals).toNumber(),
            rateUsed: 1,
        };
    }

    const rateDec = toDecimal(manualRate);
    if (!manualRate || rateDec.lte(0)) {
        const err = new Error(`Manual exchangeRate (Kz per USD) is required to convert ${from} to ${to}.`);
        err.statusCode = 400;
        throw err;
    }

    const resultDec =
        from === 'USD' && to === 'Kz' ? amtDec.times(rateDec) : amtDec.div(rateDec);

    return {
        convertedAmount: resultDec.toDecimalPlaces(decimals).toNumber(),
        rateUsed: rateDec.toDecimalPlaces(6).toNumber(),
    };
}

function resolveReturnUnitPrice(product, priceList = 'CASH', explicitPrice = null, canOverridePrice = false) {
    if (explicitPrice !== null && explicitPrice !== undefined) {
        if (!canOverridePrice) {
            const err = new Error(`Custom unitPrice is not permitted for product ${product.sku}. Price must come from price list "${priceList}".`);
            err.statusCode = 403;
            throw err;
        }
        const dec = toDecimal(explicitPrice);
        if (dec.lt(0)) {
            const err = new Error(`Return unit price cannot be negative for product ${product.sku}.`);
            err.statusCode = 400;
            throw err;
        }
        return dec.toDecimalPlaces(4).toNumber();
    }

    const key = String(priceList || 'CASH').toLowerCase();
    const mapped = product.prices?.[key];
    if (mapped === undefined || mapped === null) {
        const err = new Error(`Price list "${priceList}" not defined for product ${product.sku}.`);
        err.statusCode = 400;
        throw err;
    }
    return toDecimal(mapped).toDecimalPlaces(4).toNumber();
}

async function createReturnInvoice({
    customerId = null,
    priceList = null,
    items = [],
    refunds = [],
    reason = '',
    performedBy = null,
    date = new Date(),
    allowCustomPrice = false,
    permissions = [],
    userRole = null,
}) {
    if (!Array.isArray(items) || items.length === 0) {
        const err = new Error('Return invoice must contain at least one item.');
        err.statusCode = 400;
        throw err;
    }

    const canOverridePrice = hasCustomPricePermission({ allowCustomPrice, permissions, userRole });

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

        const effectivePriceList = priceList || customer?.type || 'CASH';
        const returnNumber = await getNextSequence('RETURN', 'RET', session);

        let totalsUsd = toDecimal(0);
        let totalsKz = toDecimal(0);
        const processedItems = [];

        for (const rawItem of items) {
            const qtyDec = toDecimal(rawItem.quantity);
            if (qtyDec.lte(0)) {
                const err = new Error('Return item quantity must be greater than zero.');
                err.statusCode = 400;
                throw err;
            }

            const product = await Product.findById(rawItem.productId).session(session);
            if (!product) {
                const err = new Error(`Product not found: ${rawItem.productId}`);
                err.statusCode = 404;
                throw err;
            }

            assertValidCurrency(product.currency, `product ${product.sku}`);
            if (rawItem.currency) {
                assertSameCurrency(
                    product.currency,
                    normalizeCurrency(rawItem.currency),
                    `return item (${product.sku})`
                );
            }

            const stockBucket = rawItem.stockBucket === 'DAMAGED' ? 'DAMAGED' : 'AVAILABLE';
            const unitPrice = resolveReturnUnitPrice(product, effectivePriceList, rawItem.unitPrice, canOverridePrice);
            const cleanQty = qtyDec.toDecimalPlaces(6).toNumber();
            const lineTotal = mulMoney(cleanQty, unitPrice, 2);

            const returnUnitCost =
                rawItem.unitCost !== undefined && rawItem.unitCost !== null
                    ? toDecimal(rawItem.unitCost).toDecimalPlaces(4).toNumber()
                    : product.cost;

            await receiveStock(
                {
                    productId: product._id,
                    quantity: cleanQty,
                    unitCost: returnUnitCost,
                    currency: product.currency,
                    stockBucket,
                    referenceType: 'RETURN',
                    referenceNumber: returnNumber,
                    reason: reason || `Return ${returnNumber} (${stockBucket})`,
                    performedBy,
                    date,
                },
                session
            );

            if (product.currency === 'USD') {
                totalsUsd = totalsUsd.plus(lineTotal);
            } else {
                totalsKz = totalsKz.plus(lineTotal);
            }

            processedItems.push({
                productId: product._id,
                skuSnapshot: product.sku,
                nameSnapshot: product.name,
                stockBucket,
                quantity: cleanQty,
                unitPrice,
                currency: product.currency,
                lineTotal,
                unitCostSnapshot: returnUnitCost,
            });
        }

        const finalTotals = {
            usd: totalsUsd.toDecimalPlaces(2).toNumber(),
            kz: totalsKz.toDecimalPlaces(2).toNumber(),
        };

        let refundedUsd = toDecimal(0);
        let refundedKz = toDecimal(0);

        for (const ref of refunds) {
            const amtDec = toDecimal(ref.amount);
            if (amtDec.lte(0)) {
                const err = new Error('Refund amount must be greater than zero.');
                err.statusCode = 400;
                throw err;
            }

            const cashbox = await Cashbox.findById(ref.cashboxId).session(session);
            if (!cashbox) {
                const err = new Error('Refund cashbox not found.');
                err.statusCode = 404;
                throw err;
            }

            assertValidCurrency(cashbox.currency, 'refund cashbox currency');
            const refCurr = normalizeCurrency(ref.currency || cashbox.currency);
            assertValidCurrency(refCurr, 'refund currency');
            const targetReturnCurr = normalizeCurrency(ref.targetCurrency || refCurr);
            assertValidCurrency(targetReturnCurr, 'target return currency');

            const { convertedAmount: cashboxAmtRounded } = convertWithManualRate(
                amtDec,
                refCurr,
                cashbox.currency,
                ref.exchangeRate,
                2
            );

            const { convertedAmount: returnCurrAmtRounded } = convertWithManualRate(
                amtDec,
                refCurr,
                targetReturnCurr,
                ref.exchangeRate,
                2
            );

            await recordCashMovement(
                {
                    cashboxId: cashbox._id,
                    direction: 'OUT',
                    amount: cashboxAmtRounded,
                    currency: cashbox.currency,
                    category: 'RETURN_REFUND',
                    referenceType: 'RETURN',
                    referenceNumber: returnNumber,
                    description: ref.notes || reason || `Cash refund for return ${returnNumber}`,
                    reason: reason || `Return refund ${returnNumber}`,
                    performedBy,
                    date,
                },
                session
            );

            if (targetReturnCurr === 'USD') {
                refundedUsd = refundedUsd.plus(returnCurrAmtRounded);
            } else {
                refundedKz = refundedKz.plus(returnCurrAmtRounded);
            }
        }

        const finalRefunded = {
            usd: refundedUsd.toDecimalPlaces(2).toNumber(),
            kz: refundedKz.toDecimalPlaces(2).toNumber(),
        };

        if (
            toDecimal(finalRefunded.usd).gt(finalTotals.usd) ||
            toDecimal(finalRefunded.kz).gt(finalTotals.kz)
        ) {
            const err = new Error('Refunded amount cannot exceed return invoice totals.');
            err.statusCode = 400;
            throw err;
        }

        const finalCredited = customer
            ? {
                usd: subMoney(finalTotals.usd, finalRefunded.usd, 2),
                kz: subMoney(finalTotals.kz, finalRefunded.kz, 2),
            }
            : { usd: 0, kz: 0 };

        const returnDoc = new ReturnInvoice({
            number: returnNumber,
            customerId: customer ? customer._id : null,
            customerNameSnapshot: customer ? customer.name : 'Walk-in Customer',
            date,
            items: processedItems,
            totals: finalTotals,
            refundedAmount: finalRefunded,
            creditedAmount: finalCredited,
            reason,
            createdBy: performedBy,
        });

        await returnDoc.save({ session });

        if (customer) {
            customer.balances.usd = subMoney(customer.balances.usd, finalCredited.usd, 2);
            customer.balances.kz = subMoney(customer.balances.kz, finalCredited.kz, 2);

            if (toDecimal(customer.balances.usd).lt(0)) {
                const excessUsd = toDecimal(customer.balances.usd).abs().toDecimalPlaces(2).toNumber();
                customer.creditBalances.usd = addMoney(customer.creditBalances.usd, excessUsd, 2);
                customer.balances.usd = 0;
            }
            if (toDecimal(customer.balances.kz).lt(0)) {
                const excessKz = toDecimal(customer.balances.kz).abs().toDecimalPlaces(2).toNumber();
                customer.creditBalances.kz = addMoney(customer.creditBalances.kz, excessKz, 2);
                customer.balances.kz = 0;
            }

            await customer.save({ session });
        }

        await logAudit(
            {
                entityType: 'ReturnInvoice',
                entityId: returnDoc._id,
                entityNumber: returnDoc.number,
                action: 'CREATE',
                reason: reason || `Created standalone return ${returnDoc.number}`,
                before: null,
                after: {
                    number: returnDoc.number,
                    totals: returnDoc.totals,
                    refundedAmount: returnDoc.refundedAmount,
                    creditedAmount: returnDoc.creditedAmount,
                    itemsCount: processedItems.length,
                },
                performedBy,
                timestamp: date,
            },
            session
        );

        return {
            returnInvoice: returnDoc,
            items: processedItems,
            customer,
        };
    });
}

module.exports = {
    createReturnInvoice,
    convertWithManualRate,
};