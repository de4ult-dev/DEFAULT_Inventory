const Invoice = require('../invoices/invoice');
const Expense = require('../expenses/expense');
const Collection = require('../collections/collection');
const Customer = require('../customers/customer');
const Supplier = require('../suppliers/supplier');
const { toDecimal } = require('../../shared/utils/money');

function buildDateRange(from, to) {
    if (!from && !to) return undefined;
    const range = {};
    if (from) range.$gte = new Date(from);
    if (to) range.$lte = new Date(to);
    return range;
}

async function getSalesReport({ from = null, to = null, customerId = null, status = null } = {}) {
    const query = {};
    const dateRange = buildDateRange(from, to);
    if (dateRange) query.date = dateRange;
    if (customerId) query.customerId = customerId;
    if (status) {
        query.status = status;
    } else {
        query.status = { $ne: 'CANCELLED' };
    }

    const rows = await Invoice.find(query).sort({ date: -1, createdAt: -1 }).lean();

    let totalUsd = toDecimal(0);
    let totalKz = toDecimal(0);
    let paidUsd = toDecimal(0);
    let paidKz = toDecimal(0);
    let remUsd = toDecimal(0);
    let remKz = toDecimal(0);

    for (const r of rows) {
        totalUsd = totalUsd.plus(toDecimal(r.totals?.usd));
        totalKz = totalKz.plus(toDecimal(r.totals?.kz));
        paidUsd = paidUsd.plus(toDecimal(r.paidAmount?.usd));
        paidKz = paidKz.plus(toDecimal(r.paidAmount?.kz));
        remUsd = remUsd.plus(toDecimal(r.remainingAmount?.usd));
        remKz = remKz.plus(toDecimal(r.remainingAmount?.kz));
    }

    return {
        count: rows.length,
        summary: {
            totals: { usd: totalUsd.toDecimalPlaces(2).toNumber(), kz: totalKz.toDecimalPlaces(2).toNumber() },
            paid: { usd: paidUsd.toDecimalPlaces(2).toNumber(), kz: paidKz.toDecimalPlaces(2).toNumber() },
            remaining: { usd: remUsd.toDecimalPlaces(2).toNumber(), kz: remKz.toDecimalPlaces(2).toNumber() },
        },
        rows,
    };
}

async function getExpensesReport({ from = null, to = null, category = null, cashboxId = null } = {}) {
    const query = { status: { $ne: 'CANCELLED' } };
    const dateRange = buildDateRange(from, to);
    if (dateRange) query.date = dateRange;
    if (category) query.category = String(category).toUpperCase();
    if (cashboxId) query.cashboxId = cashboxId;

    const rows = await Expense.find(query).sort({ date: -1, createdAt: -1 }).lean();

    let usd = toDecimal(0);
    let kz = toDecimal(0);
    const byCategory = {};

    for (const r of rows) {
        const amt = toDecimal(r.amount);
        if (r.currency === 'USD') usd = usd.plus(amt);
        else kz = kz.plus(amt);

        if (!byCategory[r.category]) {
            byCategory[r.category] = { usd: toDecimal(0), kz: toDecimal(0), count: 0 };
        }
        byCategory[r.category].count += 1;
        if (r.currency === 'USD') byCategory[r.category].usd = byCategory[r.category].usd.plus(amt);
        else byCategory[r.category].kz = byCategory[r.category].kz.plus(amt);
    }

    const formattedCategories = {};
    for (const [cat, val] of Object.entries(byCategory)) {
        formattedCategories[cat] = {
            count: val.count,
            usd: val.usd.toDecimalPlaces(2).toNumber(),
            kz: val.kz.toDecimalPlaces(2).toNumber(),
        };
    }

    return {
        count: rows.length,
        summary: {
            usd: usd.toDecimalPlaces(2).toNumber(),
            kz: kz.toDecimalPlaces(2).toNumber(),
        },
        byCategory: formattedCategories,
        rows,
    };
}

async function getCollectionsReport({ from = null, to = null, customerId = null } = {}) {
    const query = { status: { $ne: 'CANCELLED' } };
    const dateRange = buildDateRange(from, to);
    if (dateRange) query.date = dateRange;
    if (customerId) query.customerId = customerId;

    const rows = await Collection.find(query).sort({ date: -1, createdAt: -1 }).lean();

    let cashboxUsd = toDecimal(0);
    let cashboxKz = toDecimal(0);
    let settledUsd = toDecimal(0);
    let settledKz = toDecimal(0);

    for (const r of rows) {
        if (r.cashboxCurrency === 'USD') cashboxUsd = cashboxUsd.plus(toDecimal(r.cashboxAmount));
        else cashboxKz = cashboxKz.plus(toDecimal(r.cashboxAmount));

        if (r.debtCurrency === 'USD') settledUsd = settledUsd.plus(toDecimal(r.settledAmount));
        else settledKz = settledKz.plus(toDecimal(r.settledAmount));
    }

    return {
        count: rows.length,
        summary: {
            cashboxReceived: {
                usd: cashboxUsd.toDecimalPlaces(2).toNumber(),
                kz: cashboxKz.toDecimalPlaces(2).toNumber(),
            },
            debtSettled: {
                usd: settledUsd.toDecimalPlaces(2).toNumber(),
                kz: settledKz.toDecimalPlaces(2).toNumber(),
            },
        },
        rows,
    };
}

async function getPartyBalancesReport() {
    const [customers, suppliers] = await Promise.all([
        Customer.find({ isActive: { $ne: false } }).sort({ name: 1 }).lean(),
        Supplier.find({ isActive: { $ne: false } }).sort({ name: 1 }).lean(),
    ]);

    return {
        customers,
        suppliers,
    };
}

module.exports = {
    getSalesReport,
    getExpensesReport,
    getCollectionsReport,
    getPartyBalancesReport,
};