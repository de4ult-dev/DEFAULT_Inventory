const mongoose = require('mongoose');
const Invoice = require('../invoices/invoice');
const Payment = require('../invoices/payment');
const Collection = require('../collections/collection');
const ReturnInvoice = require('../returns/returnInvoice');
const { runInTransaction } = require('../../shared/utils/transaction');
const { addMoney, subMoney, toDecimal } = require('../../shared/utils/money');
const { assertValidCurrency } = require('../../shared/utils/guards');
const { logAudit } = require('../../shared/services/audit.service');

const customerSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'Customer name is required'],
            trim: true,
        },
        type: {
            type: String,
            enum: ['CASH', 'CREDIT', 'WHOLESALE'],
            default: 'CASH',
        },
        phone: {
            type: String,
            trim: true,
            default: '',
        },
        whatsapp: {
            type: String,
            trim: true,
            default: '',
        },
        address: {
            type: String,
            trim: true,
            default: '',
        },
        taxId: {
            type: String,
            trim: true,
            default: '',
        },
        notes: {
            type: String,
            trim: true,
            default: '',
        },
        balances: {
            usd: { type: Number, default: 0 },
            kz: { type: Number, default: 0 },
        },
        // رصيد دائن / مقدم للعميل (منفصل لكل عملة)
        creditBalances: {
            usd: { type: Number, default: 0, min: 0 },
            kz: { type: Number, default: 0, min: 0 },
        },
        // حد ائتماني اختياري لكل عملة
        creditLimits: {
            usd: { type: Number, default: null, min: 0 },
            kz: { type: Number, default: null, min: 0 },
        },
        isActive: {
            type: Boolean,
            default: true,
        },
    },
    { timestamps: true }
);

customerSchema.index({ name: 1 });
customerSchema.index({ phone: 1 });

const Customer = mongoose.models.Customer || mongoose.model('Customer', customerSchema);

function normalizeCurrency(curr) {
    if (!curr) return curr;
    const trimmed = String(curr).trim();
    if (trimmed.toUpperCase() === 'USD') return 'USD';
    if (trimmed.toUpperCase() === 'KZ') return 'Kz';
    return trimmed;
}

function convertWithManualRateLocal(amount, fromCurrency, toCurrency, manualRate, decimals = 2) {
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

/**
 * Applies part or all of a customer's available `creditBalances` (in `creditCurrency`)
 * toward reducing their outstanding debt (`balances` in `debtCurrency`),
 * optionally allocating against a specific invoice.
 */
async function applyCreditToBalance({
    customerId,
    amount,
    creditCurrency = 'Kz',
    debtCurrency = null,
    exchangeRate = null,
    invoiceId = null,
    reason = '',
    performedBy = null,
    date = new Date(),
}) {
    if (!customerId) {
        const err = new Error('customerId is required.');
        err.statusCode = 400;
        throw err;
    }

    const amtDec = toDecimal(amount);
    if (amtDec.lte(0)) {
        const err = new Error('Credit amount to apply must be greater than zero.');
        err.statusCode = 400;
        throw err;
    }

    const credCurr = normalizeCurrency(creditCurrency);
    assertValidCurrency(credCurr, 'credit currency');

    const targetDebtCurr = normalizeCurrency(debtCurrency || credCurr);
    assertValidCurrency(targetDebtCurr, 'debt currency');

    return runInTransaction(async (session) => {
        const customer = await Customer.findById(customerId).session(session);
        if (!customer) {
            const err = new Error('Customer not found.');
            err.statusCode = 404;
            throw err;
        }

        const credKey = credCurr === 'USD' ? 'usd' : 'kz';
        const debtKey = targetDebtCurr === 'USD' ? 'usd' : 'kz';

        const availableCreditDec = toDecimal(customer.creditBalances?.[credKey] || 0);
        const creditToUseRounded = amtDec.toDecimalPlaces(2).toNumber();

        if (toDecimal(creditToUseRounded).gt(availableCreditDec)) {
            const err = new Error(
                `Insufficient ${credCurr} credit balance. Available: ${availableCreditDec.toNumber()}, requested: ${creditToUseRounded}.`
            );
            err.statusCode = 400;
            throw err;
        }

        const { convertedAmount: settledDebtRounded, rateUsed } = convertWithManualRateLocal(
            creditToUseRounded,
            credCurr,
            targetDebtCurr,
            exchangeRate,
            2
        );

        const currentDebtDec = toDecimal(customer.balances?.[debtKey] || 0);
        if (currentDebtDec.lte(0)) {
            const err = new Error(`Customer has no outstanding ${targetDebtCurr} debt balance to settle.`);
            err.statusCode = 400;
            throw err;
        }

        if (toDecimal(settledDebtRounded).gt(currentDebtDec)) {
            const err = new Error(
                `Converted credit amount (${settledDebtRounded} ${targetDebtCurr}) exceeds current ${targetDebtCurr} debt balance (${currentDebtDec.toNumber()}).`
            );
            err.statusCode = 400;
            throw err;
        }

        let targetInvoice = null;
        if (invoiceId) {
            targetInvoice = await Invoice.findById(invoiceId).session(session);
            if (!targetInvoice) {
                const err = new Error('Target invoice not found.');
                err.statusCode = 404;
                throw err;
            }
            if (String(targetInvoice.customerId) !== String(customer._id)) {
                const err = new Error(`Invoice ${targetInvoice.number} does not belong to customer ${customer.name}.`);
                err.statusCode = 400;
                throw err;
            }
            const invRemDec = toDecimal(targetInvoice.remainingAmount?.[debtKey] || 0);
            if (toDecimal(settledDebtRounded).gt(invRemDec)) {
                const err = new Error(
                    `Amount (${settledDebtRounded} ${targetDebtCurr}) exceeds remaining balance (${invRemDec.toNumber()} ${targetDebtCurr}) on invoice ${targetInvoice.number}.`
                );
                err.statusCode = 400;
                throw err;
            }
        }

        const beforeSnapshot = {
            balances: { ...customer.balances },
            creditBalances: { ...customer.creditBalances },
            invoice: targetInvoice
                ? {
                    number: targetInvoice.number,
                    paidAmount: { ...targetInvoice.paidAmount },
                    remainingAmount: { ...targetInvoice.remainingAmount },
                    status: targetInvoice.status,
                }
                : null,
        };

        customer.creditBalances[credKey] = subMoney(availableCreditDec, creditToUseRounded, 2);
        customer.balances[debtKey] = subMoney(currentDebtDec, settledDebtRounded, 2);
        await customer.save({ session });

        if (targetInvoice) {
            targetInvoice.paidAmount[debtKey] = addMoney(
                targetInvoice.paidAmount[debtKey],
                settledDebtRounded,
                2
            );
            targetInvoice.remainingAmount[debtKey] = subMoney(
                targetInvoice.remainingAmount[debtKey],
                settledDebtRounded,
                2
            );
            const remUsd = toDecimal(targetInvoice.remainingAmount.usd);
            const remKz = toDecimal(targetInvoice.remainingAmount.kz);
            targetInvoice.status = remUsd.lte(0) && remKz.lte(0) ? 'PAID' : 'PARTIAL';
            await targetInvoice.save({ session });
        }

        await logAudit(
            {
                entityType: 'Customer',
                entityId: customer._id,
                entityNumber: customer.name,
                action: 'APPLY_CREDIT',
                reason:
                    reason ||
                    `Applied ${creditToUseRounded} ${credCurr} credit to settle ${settledDebtRounded} ${targetDebtCurr} balance`,
                before: beforeSnapshot,
                after: {
                    creditUsed: { amount: creditToUseRounded, currency: credCurr },
                    debtSettled: { amount: settledDebtRounded, currency: targetDebtCurr },
                    exchangeRate: rateUsed,
                    balances: customer.balances,
                    creditBalances: customer.creditBalances,
                    invoice: targetInvoice
                        ? {
                            number: targetInvoice.number,
                            paidAmount: targetInvoice.paidAmount,
                            remainingAmount: targetInvoice.remainingAmount,
                            status: targetInvoice.status,
                        }
                        : null,
                },
                performedBy,
                timestamp: date,
            },
            session
        );

        return {
            customer,
            invoice: targetInvoice,
            applied: {
                creditUsed: creditToUseRounded,
                creditCurrency: credCurr,
                debtSettled: settledDebtRounded,
                debtCurrency: targetDebtCurr,
                exchangeRate: rateUsed,
            },
        };
    });
}

/**
 * Adds or deducts customer creditBalance (`ADD` or `DEDUCT`) inside a transaction with audit logging.
 */
async function adjustCustomerCredit({
    customerId,
    amount,
    currency = 'Kz',
    mode = 'ADD',
    reason = '',
    performedBy = null,
    date = new Date(),
}) {
    if (!customerId) {
        const err = new Error('customerId is required.');
        err.statusCode = 400;
        throw err;
    }

    const amtDec = toDecimal(amount);
    if (amtDec.lte(0)) {
        const err = new Error('Credit adjustment amount must be greater than zero.');
        err.statusCode = 400;
        throw err;
    }

    const curr = normalizeCurrency(currency);
    assertValidCurrency(curr, 'credit currency');
    const key = curr === 'USD' ? 'usd' : 'kz';
    const normalizedMode = String(mode).toUpperCase() === 'DEDUCT' ? 'DEDUCT' : 'ADD';
    const roundedAmt = amtDec.toDecimalPlaces(2).toNumber();

    return runInTransaction(async (session) => {
        const customer = await Customer.findById(customerId).session(session);
        if (!customer) {
            const err = new Error('Customer not found.');
            err.statusCode = 404;
            throw err;
        }

        const currentCreditDec = toDecimal(customer.creditBalances?.[key] || 0);
        if (normalizedMode === 'DEDUCT' && currentCreditDec.lt(roundedAmt)) {
            const err = new Error(
                `Cannot deduct ${roundedAmt} ${curr} credit; available credit is ${currentCreditDec.toNumber()}.`
            );
            err.statusCode = 400;
            throw err;
        }

        const beforeCredit = { ...customer.creditBalances };
        customer.creditBalances[key] =
            normalizedMode === 'ADD'
                ? addMoney(currentCreditDec, roundedAmt, 2)
                : subMoney(currentCreditDec, roundedAmt, 2);

        await customer.save({ session });

        await logAudit(
            {
                entityType: 'Customer',
                entityId: customer._id,
                entityNumber: customer.name,
                action: normalizedMode === 'ADD' ? 'CREDIT_ADD' : 'CREDIT_DEDUCT',
                reason: reason || `${normalizedMode} ${roundedAmt} ${curr} credit balance`,
                before: { creditBalances: beforeCredit },
                after: { creditBalances: customer.creditBalances },
                performedBy,
                timestamp: date,
            },
            session
        );

        return customer;
    });
}

/**
 * Returns a consolidated chronological ledger/statement for a customer
 * across Invoices, Collections, ReturnInvoices, and Payments.
 */
async function getCustomerStatement(customerId, { from = null, to = null } = {}) {
    const customer = await Customer.findById(customerId).lean();
    if (!customer) {
        const err = new Error('Customer not found.');
        err.statusCode = 404;
        throw err;
    }

    const dateFilter = {};
    if (from) dateFilter.$gte = new Date(from);
    if (to) dateFilter.$lte = new Date(to);
    const hasDateFilter = Object.keys(dateFilter).length > 0;

    const baseQuery = { customerId: new mongoose.Types.ObjectId(customerId) };
    if (hasDateFilter) baseQuery.date = dateFilter;

    const [invoices, collections, returns, payments] = await Promise.all([
        Invoice.find(baseQuery).sort({ date: 1, createdAt: 1 }).lean(),
        Collection.find(baseQuery).sort({ date: 1, createdAt: 1 }).lean(),
        ReturnInvoice.find(baseQuery).sort({ date: 1, createdAt: 1 }).lean(),
        Payment.find(baseQuery).sort({ date: 1, createdAt: 1 }).lean(),
    ]);

    const entries = [
        ...invoices.map((inv) => ({
            entryType: 'INVOICE',
            referenceNumber: inv.number,
            date: inv.date,
            status: inv.status,
            amounts: inv.totals,
            remaining: inv.remainingAmount,
            notes: inv.notes || '',
        })),
        ...collections.map((col) => ({
            entryType: 'COLLECTION',
            referenceNumber: col.number,
            date: col.date,
            status: col.applyMode,
            payment: { amount: col.originalAmount, currency: col.paymentCurrency },
            settled: { amount: col.settledAmount, currency: col.debtCurrency },
            exchangeRate: col.exchangeRate,
            notes: col.notes || '',
        })),
        ...returns.map((ret) => ({
            entryType: 'RETURN',
            referenceNumber: ret.number,
            date: ret.date,
            totals: ret.totals,
            refunded: ret.refundedAmount,
            credited: ret.creditedAmount,
            notes: ret.reason || '',
        })),
        ...payments.map((pmt) => ({
            entryType: 'PAYMENT',
            referenceNumber: pmt.number,
            date: pmt.date,
            invoiceId: pmt.invoiceId,
            payment: { amount: pmt.originalAmount, currency: pmt.paymentCurrency },
            settled: { amount: pmt.settledAmount, currency: pmt.invoiceCurrency },
            exchangeRate: pmt.exchangeRate,
            notes: pmt.notes || '',
        })),
    ].sort((a, b) => new Date(a.date) - new Date(b.date));

    return {
        customer,
        summary: {
            currentBalances: customer.balances,
            creditBalances: customer.creditBalances,
            creditLimits: customer.creditLimits,
        },
        entries,
    };
}

// Attach service methods onto the Mongoose model so both model & service helpers are accessible
Customer.applyCreditToBalance = applyCreditToBalance;
Customer.adjustCustomerCredit = adjustCustomerCredit;
Customer.getCustomerStatement = getCustomerStatement;

module.exports = Customer;