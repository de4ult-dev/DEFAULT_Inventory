const fs = require('fs');
const path = require('path');
const assert = require('assert');

// تحميل متغيرات البيئة من .env تلقائياً
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (match && !process.env[match[1]]) {
            process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
        }
    }
}

const { connectDB, disconnectDB } = require('../src/shared/config/db');
const { addMoney } = require('../src/shared/utils/money');
const { getNextSequence } = require('../src/shared/services/sequence.service');
const { logAudit } = require('../src/shared/services/audit.service');

const Customer = require('../src/modules/customers/customer');
const Supplier = require('../src/modules/suppliers/supplier');
const Cashbox = require('../src/modules/treasury/cashbox');
const AuditLog = require('../src/shared/models/auditLog');
const Counter = require('../src/shared/models/counter');

function toNum(val) {
    if (val === null || val === undefined) return 0;
    if (typeof val === 'object' && typeof val.toString === 'function') {
        return Number(val.toString());
    }
    return Number(val);
}

function getBalance(doc, currency) {
    const key = String(currency || '').toLowerCase();
    const obj = doc.toObject ? doc.toObject() : doc;
    const rawBalances = obj.balances instanceof Map ? Object.fromEntries(obj.balances) : obj.balances;
    if (rawBalances && typeof rawBalances === 'object') {
        if (key in rawBalances) return toNum(rawBalances[key]);
        if (currency in rawBalances) return toNum(rawBalances[currency]);
    }
    return 0;
}

function buildExportSnapshot({ cashboxes, customers, suppliers, auditLogs }) {
    const treasuryTotals = cashboxes.reduce(
        (acc, box) => {
            const cur = String(box.currency || '').toUpperCase();
            const bal = toNum(box.balance);
            if (cur === 'USD') acc.usd = addMoney(acc.usd, bal);
            else acc.kz = addMoney(acc.kz, bal);
            return acc;
        },
        { kz: 0, usd: 0 }
    );

    const receivablesTotals = customers.reduce(
        (acc, cust) => {
            acc.kz = addMoney(acc.kz, getBalance(cust, 'kz'));
            acc.usd = addMoney(acc.usd, getBalance(cust, 'usd'));
            return acc;
        },
        { kz: 0, usd: 0 }
    );

    const payablesTotals = suppliers.reduce(
        (acc, supp) => {
            acc.kz = addMoney(acc.kz, getBalance(supp, 'kz'));
            acc.usd = addMoney(acc.usd, getBalance(supp, 'usd'));
            return acc;
        },
        { kz: 0, usd: 0 }
    );

    const csvRows = [
        'section,currency,amount',
        `treasury,Kz,${treasuryTotals.kz}`,
        `treasury,USD,${treasuryTotals.usd}`,
        `receivables,Kz,${receivablesTotals.kz}`,
        `receivables,USD,${receivablesTotals.usd}`,
        `payables,Kz,${payablesTotals.kz}`,
        `payables,USD,${payablesTotals.usd}`,
    ];

    return {
        generatedAt: new Date().toISOString(),
        treasuryTotals,
        receivablesTotals,
        payablesTotals,
        auditCount: auditLogs.length,
        csvContent: csvRows.join('\n'),
    };
}

async function runReportsQaTests() {
    const testUri = process.env.TEST_MONGO_URI || process.env.MONGO_URI;
    if (!testUri) {
        throw new Error('Set TEST_MONGO_URI or MONGO_URI before running tests.');
    }

    await connectDB(testUri);
    console.log('--- Connected to DB for Reports, Exports & QA Tests ---');

    const createdIds = {
        customers: [],
        suppliers: [],
        cashboxes: [],
        auditLogs: [],
        counterKeys: [],
    };

    try {
        const seqKey = `QA_TEST_SEQ_${Date.now()}`;
        createdIds.counterKeys.push(seqKey);

        console.log('[1/3] Seeding multi-currency records for operational report aggregation...');
        const [kzBox, usdBox] = await Cashbox.create([
            { name: `QA Kz Box ${Date.now()}`, currency: 'Kz', balance: 12500.25, isActive: true },
            { name: `QA USD Box ${Date.now()}`, currency: 'USD', balance: 350.75, isActive: true },
        ]);
        createdIds.cashboxes.push(kzBox._id, usdBox._id);

        const [customer] = await Customer.create([
            {
                name: `QA Customer ${Date.now()}`,
                phone: `+244920${Math.floor(100000 + Math.random() * 899999)}`,
                tier: 'CREDIT',
                balances: { kz: 42000.5, usd: 150 },
                isActive: true,
            },
        ]);
        createdIds.customers.push(customer._id);
        await Customer.updateOne({ _id: customer._id }, { $set: { 'balances.kz': 42000.5, 'balances.usd': 150 } });

        const [supplier] = await Supplier.create([
            {
                name: `QA Supplier ${Date.now()}`,
                type: 'EXTERNAL',
                defaultCurrency: 'USD',
                balances: { kz: 18000, usd: 600.25 },
                isActive: true,
            },
        ]);
        createdIds.suppliers.push(supplier._id);
        await Supplier.updateOne({ _id: supplier._id }, { $set: { 'balances.kz': 18000, 'balances.usd': 600.25 } });

        const qaNumber = await getNextSequence(seqKey, 'QA');
        const auditDoc = await logAudit({
            entityType: 'QAReport',
            entityNumber: qaNumber,
            action: 'CREATE',
            reason: 'Verified multi-currency operational summary & export structure',
            after: { status: 'OK' },
        });
        if (auditDoc?._id) createdIds.auditLogs.push(auditDoc._id);

        const [freshBoxes, freshCustomers, freshSuppliers, freshAudits] = await Promise.all([
            Cashbox.find({ _id: { $in: createdIds.cashboxes } }),
            Customer.find({ _id: { $in: createdIds.customers } }),
            Supplier.find({ _id: { $in: createdIds.suppliers } }),
            AuditLog.find({ _id: { $in: createdIds.auditLogs } }),
        ]);

        console.log('[2/3] Verifying multi-currency totals & export payload integrity...');
        const snapshot = buildExportSnapshot({
            cashboxes: freshBoxes,
            customers: freshCustomers,
            suppliers: freshSuppliers,
            auditLogs: freshAudits,
        });

        assert.strictEqual(snapshot.treasuryTotals.kz, 12500.25);
        assert.strictEqual(snapshot.treasuryTotals.usd, 350.75);
        assert.strictEqual(snapshot.receivablesTotals.kz, 42000.5);
        assert.strictEqual(snapshot.receivablesTotals.usd, 150);
        assert.strictEqual(snapshot.payablesTotals.kz, 18000);
        assert.strictEqual(snapshot.payablesTotals.usd, 600.25);
        assert.strictEqual(snapshot.auditCount, 1);
        assert(snapshot.csvContent.includes('treasury,Kz,12500.25'));
        assert(snapshot.csvContent.includes('payables,USD,600.25'));

        console.log('[3/3] Verifying sequence generator uniqueness under parallel calls...');
        const [s1, s2, s3] = await Promise.all([
            getNextSequence(seqKey, 'QA'),
            getNextSequence(seqKey, 'QA'),
            getNextSequence(seqKey, 'QA'),
        ]);
        const uniqueSeqs = new Set([s1, s2, s3]);
        assert.strictEqual(uniqueSeqs.size, 3, 'Expected strictly unique sequence numbers');

        console.log('All Reports, Exports & QA tests passed!');
    } finally {
        console.log('--- Cleaning up Reports & QA test records ---');
        if (createdIds.customers.length) {
            await Customer.deleteMany({ _id: { $in: createdIds.customers } });
        }
        if (createdIds.suppliers.length) {
            await Supplier.deleteMany({ _id: { $in: createdIds.suppliers } });
        }
        if (createdIds.cashboxes.length) {
            await Cashbox.deleteMany({ _id: { $in: createdIds.cashboxes } });
        }
        if (createdIds.auditLogs.length) {
            await AuditLog.deleteMany({ _id: { $in: createdIds.auditLogs } });
        }
        if (createdIds.counterKeys.length) {
            await Counter.deleteMany({ key: { $in: createdIds.counterKeys } });
        }
        await disconnectDB();
    }
}

runReportsQaTests().catch((err) => {
    console.error('Reports & QA test failed:', err);
    process.exit(1);
});