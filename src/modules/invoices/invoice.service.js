const Invoice = require('./invoice');
const InvoiceItem = require('./invoiceItems');
const Payment = require('./payment');
const Customer = require('../customers');
const Product = require('../inventory/product');
const Cashbox = require('../treasury/cashbox');
const { deductStock } = require('../inventory/inventory.service');
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

function resolveUnitPrice(product, priceList = 'CASH', explicitPrice = null) {
    if (explicitPrice !== null && explicitPrice !== undefined) {
        const dec = toDecimal(explicitPrice);
        if (dec.lt(0)) {
            const err = new Error(`Unit price cannot be negative for product ${product.sku}.`);
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

function computeInvoiceStatus(totals, remainingAmount, isCancelled = false) {
    if (isCancelled) return 'CANCELLED';

    const remUsd = toDecimal(remainingAmount.usd);
    const remKz = toDecimal(remainingAmount.kz);
    const totUsd = toDecimal(totals.usd);
    const totKz = toDecimal(totals.kz);

    if (remUsd.lte(0) && remKz.lte(0)) {
        return 'PAID';
    }

    const paidUsd = totUsd.minus(remUsd);
    const paidKz = totKz.minus(remKz);

    if (paidUsd.gt(0) || paidKz.gt(0)) {
        return 'PARTIAL';
    }

    return 'UNPAID';
}

async function applyPaymentToInvoice({
    invoice,
    customer,
    paymentInput,
    performedBy,
    date,
    session,
}) {
    const {
        cashboxId,
        amount,
        currency: rawPaymentCurrency,
        targetCurrency: rawTargetCurrency,
        exchangeRate: rawRate,
        notes = '',
    } = paymentInput;

    if (!cashboxId) {
        const err = new Error('cashboxId is required for a payment.');
        err.statusCode = 400;
        throw err;
    }

    const amtDec = toDecimal(amount);
    if (amtDec.lte(0)) {
        const err = new Error('Payment amount must be greater than zero.');
        err.statusCode = 400;
        throw err;
    }

    const cashbox = await Cashbox.findById(cashboxId).session(session);
    if (!cashbox) {
        const err = new Error('Payment cashbox not found.');
        err.statusCode = 404;
        throw err;
    }

    assertValidCurrency(cashbox.currency, 'cashbox currency');
    const paymentCurrency = normalizeCurrency(rawPaymentCurrency || cashbox.currency);
    assertValidCurrency(paymentCurrency, 'payment currency');

    const invoiceCurrency = normalizeCurrency(rawTargetCurrency || paymentCurrency);
    assertValidCurrency(invoiceCurrency, 'invoice currency');

    const invKey = invoiceCurrency === 'USD' ? 'usd' : 'kz';
    const remForCurr = toDecimal(invoice.remainingAmount[invKey]);
    if (remForCurr.lte(0)) {
        const err = new Error(`Invoice already has zero remaining balance in ${invoiceCurrency}.`);
        err.statusCode = 400;
        throw err;
    }

    const { convertedAmount: settledRounded, rateUsed: settledRate } = convertWithManualRate(
        amtDec,
        paymentCurrency,
        invoiceCurrency,
        rawRate,
        2
    );

    if (toDecimal(settledRounded).gt(remForCurr)) {
        const err = new Error(
            `Payment settled amount (${settledRounded} ${invoiceCurrency}) exceeds remaining invoice balance (${remForCurr.toNumber()} ${invoiceCurrency}).`
        );
        err.statusCode = 400;
        throw err;
    }

    const { convertedAmount: cashboxAmountRounded, rateUsed: cashboxRate } = convertWithManualRate(
        amtDec,
        paymentCurrency,
        cashbox.currency,
        rawRate,
        2
    );

    const effectiveRate = paymentCurrency !== invoiceCurrency ? settledRate : cashboxRate;
    const paymentNumber = await getNextSequence('PAYMENT', 'PAY', session);

    await recordCashMovement(
        {
            cashboxId: cashbox._id,
            direction: 'IN',
            amount: cashboxAmountRounded,
            currency: cashbox.currency,
            category: 'INVOICE_PAYMENT',
            referenceType: 'INVOICE',
            referenceId: invoice._id,
            referenceNumber: invoice.number,
            description: notes || `Payment ${paymentNumber} for invoice ${invoice.number}`,
            reason: `Payment ${paymentNumber}`,
            performedBy,
            date,
        },
        session
    );

    const [payment] = await Payment.create(
        [
            {
                number: paymentNumber,
                invoiceId: invoice._id,
                customerId: customer ? customer._id : null,
                cashboxId: cashbox._id,
                invoiceCurrency,
                cashboxCurrency: cashbox.currency,
                originalAmount: amtDec.toDecimalPlaces(2).toNumber(),
                paymentCurrency,
                exchangeRate: effectiveRate,
                settledAmount: settledRounded,
                cashboxAmount: cashboxAmountRounded,
                date,
                notes,
                createdBy: performedBy,
            },
        ],
        { session }
    );

    invoice.paidAmount[invKey] = addMoney(invoice.paidAmount[invKey], settledRounded, 2);
    invoice.remainingAmount[invKey] = subMoney(invoice.remainingAmount[invKey], settledRounded, 2);

    if (customer) {
        customer.balances[invKey] = subMoney(customer.balances[invKey], settledRounded, 2);
    }

    return payment;
}

async function createInvoice({
    customerId = null,
    type = 'CASH',
    priceList = null,
    items = [],
    payments = [],
    notes = '',
    performedBy = null,
    date = new Date(),
}) {
    if (!Array.isArray(items) || items.length === 0) {
        const err = new Error('Invoice must contain at least one item.');
        err.statusCode = 400;
        throw err;
    }

    const effectivePriceList =
        priceList || (type === 'WHOLESALE' ? 'WHOLESALE' : type === 'CREDIT' ? 'CREDIT' : 'CASH');

    return runInTransaction(async (session) => {
        let customer = null;
        if (customerId) {
            customer = await Customer.findById(customerId).session(session);
            if (!customer) {
                const err = new Error('Customer not found.');
                err.statusCode = 404;
                throw err;
            }
            if (!customer.isActive) {
                const err = new Error(`Customer "${customer.name}" is inactive.`);
                err.statusCode = 400;
                throw err;
            }
        }

        const invoiceNumber = await getNextSequence('INVOICE', 'INV', session);

        let totalsUsd = toDecimal(0);
        let totalsKz = toDecimal(0);
        const currenciesSeen = new Set();
        const preparedItems = [];

        for (const rawItem of items) {
            const qtyDec = toDecimal(rawItem.quantity);
            if (qtyDec.lte(0)) {
                const err = new Error('Item quantity must be greater than zero.');
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
                    `invoice item (${product.sku})`
                );
            }

            const unitPrice = resolveUnitPrice(product, effectivePriceList, rawItem.unitPrice);
            const cleanQty = qtyDec.toDecimalPlaces(6).toNumber();
            const lineTotal = mulMoney(cleanQty, unitPrice, 2);

            const stockRes = await deductStock(
                {
                    productId: product._id,
                    quantity: cleanQty,
                    unitCost: product.cost,
                    currency: product.currency,
                    stockBucket: 'AVAILABLE',
                    referenceType: 'INVOICE',
                    referenceNumber: invoiceNumber,
                    reason: `Invoice ${invoiceNumber}`,
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
            currenciesSeen.add(product.currency);

            preparedItems.push({
                productId: product._id,
                skuSnapshot: product.sku,
                nameSnapshot: product.name,
                quantity: cleanQty,
                unitPrice,
                currency: product.currency,
                lineTotal,
                unitCostSnapshot: stockRes.stockMove.unitCost,
            });
        }

        const finalTotals = {
            usd: totalsUsd.toDecimalPlaces(2).toNumber(),
            kz: totalsKz.toDecimalPlaces(2).toNumber(),
        };

        const resolvedType =
            currenciesSeen.size > 1
                ? 'MIXED'
                : ['CASH', 'CREDIT', 'WHOLESALE', 'MIXED'].includes(type)
                    ? type
                    : 'CASH';

        const invoice = new Invoice({
            number: invoiceNumber,
            customerId: customer ? customer._id : null,
            customerNameSnapshot: customer ? customer.name : 'Walk-in Customer',
            type: resolvedType,
            date,
            totals: finalTotals,
            paidAmount: { usd: 0, kz: 0 },
            remainingAmount: { usd: finalTotals.usd, kz: finalTotals.kz },
            status: 'UNPAID',
            notes,
            createdBy: performedBy,
        });

        await invoice.save({ session });

        const createdItems = await InvoiceItem.create(
            preparedItems.map((item) => ({
                ...item,
                invoiceId: invoice._id,
            })),
            { session, ordered: true }
        );

        if (customer) {
            customer.balances.usd = addMoney(customer.balances.usd, finalTotals.usd, 2);
            customer.balances.kz = addMoney(customer.balances.kz, finalTotals.kz, 2);

            if (customer.creditLimits?.usd !== null && customer.creditLimits?.usd !== undefined) {
                if (toDecimal(customer.balances.usd).gt(customer.creditLimits.usd)) {
                    const err = new Error(
                        `Customer USD balance (${customer.balances.usd}) exceeds credit limit (${customer.creditLimits.usd}).`
                    );
                    err.statusCode = 400;
                    throw err;
                }
            }
            if (customer.creditLimits?.kz !== null && customer.creditLimits?.kz !== undefined) {
                if (toDecimal(customer.balances.kz).gt(customer.creditLimits.kz)) {
                    const err = new Error(
                        `Customer Kz balance (${customer.balances.kz}) exceeds credit limit (${customer.creditLimits.kz}).`
                    );
                    err.statusCode = 400;
                    throw err;
                }
            }
        }

        const createdPayments = [];
        for (const pmt of payments) {
            const createdPmt = await applyPaymentToInvoice({
                invoice,
                customer,
                paymentInput: pmt,
                performedBy,
                date,
                session,
            });
            createdPayments.push(createdPmt);
        }

        invoice.status = computeInvoiceStatus(invoice.totals, invoice.remainingAmount, false);
        await invoice.save({ session });

        if (customer) {
            await customer.save({ session });
        }

        await logAudit(
            {
                entityType: 'Invoice',
                entityId: invoice._id,
                entityNumber: invoice.number,
                action: 'CREATE',
                reason: notes || `Created invoice ${invoice.number} (${invoice.type})`,
                before: null,
                after: {
                    number: invoice.number,
                    type: invoice.type,
                    totals: invoice.totals,
                    paidAmount: invoice.paidAmount,
                    remainingAmount: invoice.remainingAmount,
                    status: invoice.status,
                    itemsCount: createdItems.length,
                    paymentsCount: createdPayments.length,
                },
                performedBy,
                timestamp: date,
            },
            session
        );

        return {
            invoice,
            items: createdItems,
            payments: createdPayments,
            customer,
        };
    });
}

module.exports = {
    createInvoice,
    applyPaymentToInvoice,
    convertWithManualRate,
};