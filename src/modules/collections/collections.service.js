const Collection = require('./collection');
const Customer = require('../customers/customer');
const Cashbox = require('../treasury/cashbox');
const Invoice = require('../invoices/invoice');
const Payment = require('../invoices/payment');
const { recordCashMovement } = require('../treasury/treasury.service');
const { runInTransaction } = require('../../shared/utils/transaction');
const { addMoney, subMoney, toDecimal } = require('../../shared/utils/money');
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

function computeInvoiceStatus(totals, remainingAmount) {
    const remUsd = toDecimal(remainingAmount.usd);
    const remKz = toDecimal(remainingAmount.kz);
    const totUsd = toDecimal(totals.usd);
    const totKz = toDecimal(totals.kz);

    if (remUsd.lte(0) && remKz.lte(0)) {
        return 'PAID';
    }
    if (totUsd.minus(remUsd).gt(0) || totKz.minus(remKz).gt(0)) {
        return 'PARTIAL';
    }
    return 'UNPAID';
}

/**
 * Records a customer collection (`RCT-...`):
 * - Deposits `cashboxAmount` into the cashbox matching `paymentCurrency`
 * - Converts via manual `exchangeRate` (Kz per USD) if `debtCurrency` differs from `paymentCurrency`
 * - Reduces customer balance in `debtCurrency` (and moves excess over debt to `creditBalances`)
 * - Optionally allocates across specific invoices (`allocations: [{ invoiceId, amount }]`)
 */
async function createCollection({
    customerId,
    cashboxId,
    amount,
    paymentCurrency: rawPaymentCurrency = null,
    debtCurrency: rawDebtCurrency = null,
    exchangeRate = null,
    applyMode = 'CUSTOMER_BALANCE',
    allocations = [],
    notes = '',
    performedBy = null,
    date = new Date(),
}) {
    if (!customerId) {
        const err = new Error('customerId is required for a collection.');
        err.statusCode = 400;
        throw err;
    }
    if (!cashboxId) {
        const err = new Error('cashboxId is required for a collection.');
        err.statusCode = 400;
        throw err;
    }

    const amtDec = toDecimal(amount);
    if (amtDec.lte(0)) {
        const err = new Error('Collection amount must be greater than zero.');
        err.statusCode = 400;
        throw err;
    }

    return runInTransaction(async (session) => {
        const customer = await Customer.findById(customerId).session(session);
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

        const cashbox = await Cashbox.findById(cashboxId).session(session);
        if (!cashbox) {
            const err = new Error('Cashbox not found.');
            err.statusCode = 404;
            throw err;
        }
        if (cashbox.isActive === false) {
            const err = new Error(`Cashbox "${cashbox.name}" is inactive.`);
            err.statusCode = 400;
            throw err;
        }

        assertValidCurrency(cashbox.currency, 'cashbox currency');
        const paymentCurrency = normalizeCurrency(rawPaymentCurrency || cashbox.currency);
        assertValidCurrency(paymentCurrency, 'payment currency');

        if (paymentCurrency !== cashbox.currency) {
            const err = new Error(
                `Payment currency (${paymentCurrency}) must match cashbox currency (${cashbox.currency}).`
            );
            err.statusCode = 400;
            throw err;
        }

        const debtCurrency = normalizeCurrency(rawDebtCurrency || paymentCurrency);
        assertValidCurrency(debtCurrency, 'debt currency');

        const { convertedAmount: settledAmount, rateUsed } = convertWithManualRate(
            amtDec,
            paymentCurrency,
            debtCurrency,
            exchangeRate,
            2
        );

        const originalRounded = amtDec.toDecimalPlaces(2).toNumber();
        const receiptNumber = await getNextSequence('COLLECTION', 'RCT', session);

        await recordCashMovement(
            {
                cashboxId: cashbox._id,
                direction: 'IN',
                amount: originalRounded,
                currency: cashbox.currency,
                category: 'CUSTOMER_COLLECTION',
                referenceType: 'CUSTOMER',
                referenceNumber: receiptNumber,
                description: notes || `Collection ${receiptNumber} from ${customer.name}`,
                reason: notes || `Collection ${receiptNumber}`,
                performedBy,
                date,
            },
            session
        );

        const beforeCustomer = {
            balances: { ...customer.balances },
            creditBalances: { ...customer.creditBalances },
        };

        const debtKey = debtCurrency === 'USD' ? 'usd' : 'kz';
        const currentDebt = toDecimal(customer.balances[debtKey]);
        const settledDec = toDecimal(settledAmount);

        if (settledDec.gt(currentDebt)) {
            const excess = settledDec.minus(currentDebt).toDecimalPlaces(2).toNumber();
            customer.balances[debtKey] = 0;
            customer.creditBalances[debtKey] = addMoney(customer.creditBalances[debtKey], excess, 2);
        } else {
            customer.balances[debtKey] = subMoney(currentDebt, settledDec, 2);
        }

        await customer.save({ session });

        const finalAllocations = [];
        if (applyMode === 'SPECIFIC_INVOICES' && Array.isArray(allocations) && allocations.length > 0) {
            let allocatedSum = toDecimal(0);

            for (const alloc of allocations) {
                const allocAmtDec = toDecimal(alloc.amount);
                if (allocAmtDec.lte(0)) {
                    const err = new Error('Allocated amount must be greater than zero.');
                    err.statusCode = 400;
                    throw err;
                }

                const invoice = await Invoice.findById(alloc.invoiceId).session(session);
                if (!invoice) {
                    const err = new Error(`Invoice not found: ${alloc.invoiceId}`);
                    err.statusCode = 404;
                    throw err;
                }
                if (!invoice.customerId || String(invoice.customerId) !== String(customer._id)) {
                    const err = new Error(`Invoice ${invoice.number} does not belong to customer ${customer.name}.`);
                    err.statusCode = 400;
                    throw err;
                }

                const invRem = toDecimal(invoice.remainingAmount[debtKey]);
                const allocRounded = allocAmtDec.toDecimalPlaces(2).toNumber();
                if (toDecimal(allocRounded).gt(invRem)) {
                    const err = new Error(
                        `Allocated amount (${allocRounded} ${debtCurrency}) exceeds remaining balance (${invRem.toNumber()} ${debtCurrency}) on invoice ${invoice.number}.`
                    );
                    err.statusCode = 400;
                    throw err;
                }

                allocatedSum = allocatedSum.plus(allocRounded);
                if (allocatedSum.gt(settledDec)) {
                    const err = new Error(
                        `Total invoice allocations (${allocatedSum.toNumber()} ${debtCurrency}) exceed settled collection amount (${settledAmount} ${debtCurrency}).`
                    );
                    err.statusCode = 400;
                    throw err;
                }

                invoice.paidAmount[debtKey] = addMoney(invoice.paidAmount[debtKey], allocRounded, 2);
                invoice.remainingAmount[debtKey] = subMoney(invoice.remainingAmount[debtKey], allocRounded, 2);
                invoice.status = computeInvoiceStatus(invoice.totals, invoice.remainingAmount);
                await invoice.save({ session });

                await Payment.create(
                    [
                        {
                            number: await getNextSequence('PAYMENT', 'PAY', session),
                            invoiceId: invoice._id,
                            customerId: customer._id,
                            cashboxId: cashbox._id,
                            invoiceCurrency: debtCurrency,
                            cashboxCurrency: cashbox.currency,
                            originalAmount: allocRounded,
                            paymentCurrency: debtCurrency,
                            exchangeRate: rateUsed,
                            settledAmount: allocRounded,
                            cashboxAmount: allocRounded,
                            date,
                            notes: notes || `Allocated from collection ${receiptNumber}`,
                            createdBy: performedBy,
                        },
                    ],
                    { session }
                );

                finalAllocations.push({
                    invoiceId: invoice._id,
                    invoiceNumberSnapshot: invoice.number,
                    amountSettled: allocRounded,
                    currency: debtCurrency,
                });
            }
        }

        const [collectionDoc] = await Collection.create(
            [
                {
                    number: receiptNumber,
                    customerId: customer._id,
                    customerNameSnapshot: customer.name,
                    cashboxId: cashbox._id,
                    paymentCurrency,
                    debtCurrency,
                    cashboxCurrency: cashbox.currency,
                    originalAmount: originalRounded,
                    exchangeRate: rateUsed,
                    settledAmount,
                    cashboxAmount: originalRounded,
                    applyMode: finalAllocations.length > 0 ? 'SPECIFIC_INVOICES' : 'CUSTOMER_BALANCE',
                    allocations: finalAllocations,
                    date,
                    notes,
                    createdBy: performedBy,
                },
            ],
            { session }
        );

        await logAudit(
            {
                entityType: 'Collection',
                entityId: collectionDoc._id,
                entityNumber: collectionDoc.number,
                action: 'CREATE',
                reason: notes || `Recorded collection ${collectionDoc.number}`,
                before: beforeCustomer,
                after: {
                    receiptNumber: collectionDoc.number,
                    originalAmount: collectionDoc.originalAmount,
                    paymentCurrency: collectionDoc.paymentCurrency,
                    debtCurrency: collectionDoc.debtCurrency,
                    exchangeRate: collectionDoc.exchangeRate,
                    settledAmount: collectionDoc.settledAmount,
                    customerBalances: customer.balances,
                    customerCreditBalances: customer.creditBalances,
                },
                performedBy,
                timestamp: date,
            },
            session
        );

        return {
            collection: collectionDoc,
            customer,
        };
    });
}

/**
 * Reverses a collection (`RCT-...`) by withdrawing `cashboxAmount` from the cashbox (`OUT`)
 * and restoring customer balances/creditBalances inside a transaction with audit logging.
 */
async function cancelCollection({
    collectionId,
    reason = '',
    performedBy = null,
    date = new Date(),
}) {
    if (!collectionId) {
        const err = new Error('collectionId is required.');
        err.statusCode = 400;
        throw err;
    }

    return runInTransaction(async (session) => {
        const collectionDoc = await Collection.findById(collectionId).session(session);
        if (!collectionDoc) {
            const err = new Error('Collection not found.');
            err.statusCode = 404;
            throw err;
        }
        if (collectionDoc.status === 'CANCELLED') {
            const err = new Error(`Collection ${collectionDoc.number} is already cancelled.`);
            err.statusCode = 400;
            throw err;
        }

        const customer = await Customer.findById(collectionDoc.customerId).session(session);
        if (!customer) {
            const err = new Error('Customer not found for collection.');
            err.statusCode = 404;
            throw err;
        }

        const cancelReason = reason || `Cancelled collection ${collectionDoc.number}`;

        await recordCashMovement(
            {
                cashboxId: collectionDoc.cashboxId,
                direction: 'OUT',
                amount: collectionDoc.cashboxAmount,
                currency: collectionDoc.cashboxCurrency,
                category: 'COLLECTION_REVERSAL',
                referenceType: 'CUSTOMER',
                referenceId: collectionDoc._id,
                referenceNumber: collectionDoc.number,
                description: cancelReason,
                reason: cancelReason,
                performedBy,
                date,
            },
            session
        );

        const beforeCustomer = {
            balances: { ...customer.balances },
            creditBalances: { ...customer.creditBalances },
        };

        const debtKey = collectionDoc.debtCurrency === 'USD' ? 'usd' : 'kz';
        const settledDec = toDecimal(collectionDoc.settledAmount);
        const currentCreditDec = toDecimal(customer.creditBalances[debtKey] || 0);

        if (currentCreditDec.gte(settledDec)) {
            customer.creditBalances[debtKey] = subMoney(currentCreditDec, settledDec, 2);
        } else {
            const fromCredit = currentCreditDec;
            const remainingToDebt = settledDec.minus(fromCredit);
            customer.creditBalances[debtKey] = 0;
            customer.balances[debtKey] = addMoney(customer.balances[debtKey], remainingToDebt, 2);
        }

        await customer.save({ session });

        collectionDoc.status = 'CANCELLED';
        await collectionDoc.save({ session });

        await logAudit(
            {
                entityType: 'Collection',
                entityId: collectionDoc._id,
                entityNumber: collectionDoc.number,
                action: 'CANCEL',
                reason: cancelReason,
                before: beforeCustomer,
                after: {
                    status: collectionDoc.status,
                    customerBalances: customer.balances,
                    customerCreditBalances: customer.creditBalances,
                },
                performedBy,
                timestamp: date,
            },
            session
        );

        return { collection: collectionDoc, customer };
    });
}

module.exports = {
    createCollection,
    cancelCollection,
    convertWithManualRate,
};