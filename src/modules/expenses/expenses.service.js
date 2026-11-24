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

/**
 * Creates an expense (`EXP-...`) and records a cash payout (`OUT`) from the selected cashbox.
 * Supports same-currency payouts or cross-currency payouts using a manual exchange rate.
 */
async function createExpense({
    category = 'OTHER',
    amount,
    currency = 'Kz',
    cashboxId,
    exchangeRate = null,
    isLumpSum = true,
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

    const expCurrency = normalizeCurrency(currency);
    assertValidCurrency(expCurrency, 'expense currency');

    return runInTransaction(async (session) => {
        const cashbox = await Cashbox.findById(cashboxId).session(session);
        if (!cashbox) {
            const err = new Error('Cashbox not found.');
            err.statusCode = 404;
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
                    amount: cleanAmount,
                    currency: expCurrency,
                    cashboxId: cashbox._id,
                    cashboxNameSnapshot: cashbox.name,
                    paidAmount: conv.convertedAmount,
                    paidCurrency: cashbox.currency,
                    exchangeRate: conv.rateUsed,
                    isLumpSum: Boolean(isLumpSum),
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

module.exports = {
    ALLOWED_CATEGORIES,
    createExpense,
};