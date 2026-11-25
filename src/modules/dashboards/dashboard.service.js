const Cashbox = require('../treasury/cashbox');
const Customer = require('../customers/customer');
const Supplier = require('../suppliers/supplier');
const Invoice = require('../invoices/invoice');
const Expense = require('../expenses/expense');
const { getInventoryValuation } = require('../inventory/inventory.service');
const { toDecimal } = require('../../shared/utils/money');

function sumCurrencies(rows, usdGetter, kzGetter) {
    let usd = toDecimal(0);
    let kz = toDecimal(0);
    for (const row of rows) {
        usd = usd.plus(toDecimal(usdGetter(row)));
        kz = kz.plus(toDecimal(kzGetter(row)));
    }
    return {
        usd: usd.toDecimalPlaces(2).toNumber(),
        kz: kz.toDecimalPlaces(2).toNumber(),
    };
}

async function getDashboardSummary({ from = null, to = null } = {}) {
    const dateFilter = {};
    if (from || to) {
        dateFilter.date = {};
        if (from) dateFilter.date.$gte = new Date(from);
        if (to) dateFilter.date.$lte = new Date(to);
    }

    const [cashboxes, customers, suppliers, invoices, expenses, inventoryValuation] =
        await Promise.all([
            Cashbox.find({ isActive: { $ne: false } }).lean(),
            Customer.find({ isActive: { $ne: false } }).lean(),
            Supplier.find({ isActive: { $ne: false } }).lean(),
            Invoice.find({ status: { $ne: 'CANCELLED' }, ...dateFilter }).lean(),
            Expense.find({ status: { $ne: 'CANCELLED' }, ...dateFilter }).lean(),
            getInventoryValuation({ includeInactive: false }),
        ]);

    const cashBalances = sumCurrencies(
        cashboxes,
        (c) => (c.currency === 'USD' ? c.balance : 0),
        (c) => (c.currency === 'Kz' ? c.balance : 0)
    );

    const customerReceivables = sumCurrencies(
        customers,
        (c) => c.balances?.usd,
        (c) => c.balances?.kz
    );

    const customerCredits = sumCurrencies(
        customers,
        (c) => c.creditBalances?.usd,
        (c) => c.creditBalances?.kz
    );

    const supplierPayables = sumCurrencies(
        suppliers,
        (s) => s.balances?.usd,
        (s) => s.balances?.kz
    );

    const salesTotals = sumCurrencies(
        invoices,
        (inv) => inv.totals?.usd,
        (inv) => inv.totals?.kz
    );

    const salesRemaining = sumCurrencies(
        invoices,
        (inv) => inv.remainingAmount?.usd,
        (inv) => inv.remainingAmount?.kz
    );

    const expenseTotals = sumCurrencies(
        expenses,
        (exp) => (exp.currency === 'USD' ? exp.amount : 0),
        (exp) => (exp.currency === 'Kz' ? exp.amount : 0)
    );

    return {
        period: { from, to },
        cashBalances,
        customerReceivables,
        customerCredits,
        supplierPayables,
        sales: {
            count: invoices.length,
            totals: salesTotals,
            remaining: salesRemaining,
        },
        expenses: {
            count: expenses.length,
            totals: expenseTotals,
        },
        inventoryValuation,
    };
}

module.exports = { getDashboardSummary };