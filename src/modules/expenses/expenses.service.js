const Expense = require('./expense');
const Cashbox = require('../treasury/cashbox');
const { recordCashMovement } = require('../treasury/treasury.service');
const { convertWithManualRate } = require('../collections/collections.service');
const { runInTransaction } = require('../../shared/utils/transaction');
const { toDecimal } = require('../../shared/utils/money');
const { assertValidCurrency } = require('../../shared/utils/guards');
const { getNextSequence } = require('../../shared/services/sequence.service');
const { logAudit } = require('../../shared/services/audit.service');

const ALLOWED_CATEGORIES = [
    'RENT',
    'SALARIES',
    'UTILITIES',
    'TRANSPORT',
    'OFFICE',
    'MAINTENANCE',
    'OTHER',
];

function normalizeCurrency(curr) {
    if (!curr) return curr;
    const trimmed = String(curr).trim();
    if (trimmed.toUpperCase() === 'USD') return 'USD';
    if (trimmed.toUpperCase() === 'KZ') return 'Kz';
    return trimmed;
}

function hasManagerApproval({
    isApproved = false,
    approvedBy = null,
    permissions = [],
    userRole = null,
}) {
    if (isApproved === true || Boolean(approvedBy)) return true;
    if (
        Array.isArray(permissions) &&
        (permissions.includes('APPROVE_EXPENSE') || permissions.includes('MANAGER_APPROVAL'))
    ) {
        return true;
    }
    if (userRole && ['ADMIN', 'MANAGER'].includes(String(userRole).toUpperCase())) {
        return true;
    }
    return false;
}

function getCashboxBalanceByCurrency(cashbox, currency) {
    const norm = normalizeCurrency(currency);
    if (cashbox.balances && typeof cashbox.balances === 'object') {
        if (norm === 'USD' && cashbox.balances.usd !== undefined) {
            return toDecimal(cashbox.balances.usd);
        }
        if (norm === 'Kz' && cashbox.balances.kz !== undefined) {
            return toDecimal(cashbox.balances.kz);
        }
    }
    if (cashbox.balance !== undefined) {
        return toDecimal(cashbox.balance);
    }
    return toDecimal(0);
}

/**
 * Creates an expense (`EXP-...`) and records a cash payout (`OUT`) from the selected cashbox.
 * Enforces active cashbox, sufficient cashbox balance, manager approval when required,
 * and manual FX rate for cross-currency payouts.
 */
async function createExpense({
    category = 'OTHER',
    amount,
    currency = 'Kz',
    cashboxId,
    exchangeRate = null,
    isLumpSum = true,
    allowOverdraft = false,
    requireApproval = false,
    isApproved = false,
    approvedBy = null,
    permissions = [],
    userRole = null,
    description = '',
    performedBy = null,
    date = new Date(),
}) {
    const normalizedCategory = String(category || 'OTHER').trim().toUpperCase();
    if (!ALLOWED_CATEGORIES.includes(normalizedCategory)) {
        const err = new Error(`Invalid expense category: ${category}`);
        err.statusCode = 400;
        throw err;
    }

    const amountDec = toDecimal(amount);
    if (amountDec.lte(0)) {
        const err = new Error('Expense amount must be greater than zero.');
        err.statusCode = 400;
        throw err;
    }

    if (requireApproval && !hasManagerApproval({ isApproved, approvedBy, permissions, userRole })) {
        const err = new Error('Manager approval is required to record this expense.');
        err.statusCode = 403;
        throw err;
    }

    const expCurrency = normalizeCurrency(currency);
    assertValidCurrency(expCurrency, 'expense currency');

    return runInTransaction(async (session) => {
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

        const cleanAmount = amountDec.toDecimalPlaces(2).toNumber();
        const conv = convertWithManualRate(
            cleanAmount,
            expCurrency,
            cashbox.currency,
            exchangeRate,
            2
        );

        const cashboxBalDec = getCashboxBalanceByCurrency(cashbox, cashbox.currency);
        if (!allowOverdraft && cashboxBalDec.lt(conv.convertedAmount)) {
            const err = new Error(
                `Insufficient balance in cashbox "${cashbox.name}" (${cashbox.currency}). Available: ${cashboxBalDec.toNumber()}, required: ${conv.convertedAmount}.`
            );
            err.statusCode = 400;
            throw err;
        }

        const number = await getNextSequence('EXPENSE', 'EXP', session);

        const cashRes = await recordCashMovement(
            {
                cashboxId: cashbox._id,
                direction: 'OUT',
                amount: conv.convertedAmount,
                currency: cashbox.currency,
                category: 'EXPENSE',
                referenceType: 'EXPENSE',
                referenceNumber: number,
                description: description || `${normalizedCategory} expense (${number})`,
                reason: description || `Expense ${number} [${normalizedCategory}]`,
                performedBy,
                date,
            },
            session
        );

        const [expenseDoc] = await Expense.create(
            [
                {
                    number,
                    category: normalizedCategory,
                    status: 'POSTED',
                    amount: cleanAmount,
                    currency: expCurrency,
                    cashboxId: cashbox._id,
                    cashboxNameSnapshot: cashbox.name,
                    paidAmount: conv.convertedAmount,
                    paidCurrency: cashbox.currency,
                    exchangeRate: conv.rateUsed,
                    isLumpSum: Boolean(isLumpSum),
                    approvedBy: approvedBy || (hasManagerApproval({ isApproved, approvedBy, permissions, userRole }) ? performedBy : null),
                    description,
                    date,
                    createdBy: performedBy,
                },
            ],
            { session }
        );

        await logAudit(
            {
                entityType: 'Expense',
                entityId: expenseDoc._id,
                entityNumber: expenseDoc.number,
                action: 'CREATE',
                reason: description || `Created expense ${expenseDoc.number} [${normalizedCategory}]`,
                before: null,
                after: {
                    number: expenseDoc.number,
                    category: expenseDoc.category,
                    status: expenseDoc.status,
                    amount: expenseDoc.amount,
                    currency: expenseDoc.currency,
                    paidAmount: expenseDoc.paidAmount,
                    paidCurrency: expenseDoc.paidCurrency,
                    exchangeRate: expenseDoc.exchangeRate,
                },
                performedBy,
                timestamp: date,
            },
            session
        );

        return {
            expense: expenseDoc,
            cashbox: cashRes.cashbox,
            cashMove: cashRes.cashMove,
        };
    });
}

/**
 * Cancels/reverses a posted expense (`EXP-...`) and returns `paidAmount` to the cashbox (`IN`).
 */
async function cancelExpense({
    expenseId,
    reason = '',
    isApproved = false,
    approvedBy = null,
    permissions = [],
    userRole = null,
    requireApproval = true,
    performedBy = null,
    date = new Date(),
}) {
    if (!expenseId) {
        const err = new Error('expenseId is required.');
        err.statusCode = 400;
        throw err;
    }

    if (requireApproval && !hasManagerApproval({ isApproved, approvedBy, permissions, userRole })) {
        const err = new Error('Manager approval is required to cancel an expense.');
        err.statusCode = 403;
        throw err;
    }

    return runInTransaction(async (session) => {
        const expense = await Expense.findById(expenseId).session(session);
        if (!expense) {
            const err = new Error('Expense not found.');
            err.statusCode = 404;
            throw err;
        }

        if (expense.status === 'CANCELLED') {
            const err = new Error(`Expense ${expense.number} is already cancelled.`);
            err.statusCode = 400;
            throw err;
        }

        const cashbox = await Cashbox.findById(expense.cashboxId).session(session);
        if (!cashbox) {
            const err = new Error('Cashbox not found for expense reversal.');
            err.statusCode = 404;
            throw err;
        }

        if (cashbox.isActive === false) {
            const err = new Error(`Cashbox "${cashbox.name}" is inactive.`);
            err.statusCode = 400;
            throw err;
        }

        const refundAmt = toDecimal(expense.paidAmount).toDecimalPlaces(2).toNumber();
        const cancelReason = reason || `Cancelled expense ${expense.number}`;

        const cashRes = await recordCashMovement(
            {
                cashboxId: cashbox._id,
                direction: 'IN',
                amount: refundAmt,
                currency: expense.paidCurrency,
                category: 'EXPENSE_REVERSAL',
                referenceType: 'EXPENSE',
                referenceNumber: expense.number,
                description: cancelReason,
                reason: cancelReason,
                performedBy,
                date,
            },
            session
        );

        const beforeSnapshot = {
            status: expense.status,
            paidAmount: expense.paidAmount,
            paidCurrency: expense.paidCurrency,
        };

        expense.status = 'CANCELLED';
        expense.cancelReason = cancelReason;
        expense.cancelledAt = date;
        expense.cancelledBy = performedBy;
        await expense.save({ session });

        await logAudit(
            {
                entityType: 'Expense',
                entityId: expense._id,
                entityNumber: expense.number,
                action: 'CANCEL',
                reason: cancelReason,
                before: beforeSnapshot,
                after: {
                    status: expense.status,
                    cancelReason: expense.cancelReason,
                    cancelledAt: expense.cancelledAt,
                    refundedAmount: refundAmt,
                    refundedCurrency: expense.paidCurrency,
                },
                performedBy,
                timestamp: date,
            },
            session
        );

        return {
            expense,
            cashbox: cashRes.cashbox,
            cashMove: cashRes.cashMove,
        };
    });
}

module.exports = {
    ALLOWED_CATEGORIES,
    createExpense,
    cancelExpense,
};