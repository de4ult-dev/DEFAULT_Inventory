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
const { runInTransaction } = require('../src/shared/utils/transaction');
const { addMoney, subMoney, mulMoney } = require('../src/shared/utils/money');
const { assertSufficientCash } = require('../src/shared/utils/guards');
const { getNextSequence } = require('../src/shared/services/sequence.service');
const { logAudit } = require('../src/shared/services/audit.service');

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

function normalizeCurrencyKey(currency) {
    return String(currency || '').toLowerCase();
}

function getSupplierBalance(doc, currency) {
    const key = normalizeCurrencyKey(currency);
    const obj = doc.toObject ? doc.toObject() : doc;
    const rawBalances = obj.balances instanceof Map ? Object.fromEntries(obj.balances) : obj.balances;
    if (rawBalances && typeof rawBalances === 'object') {
        if (key in rawBalances) return toNum(rawBalances[key]);
        if (currency in rawBalances) return toNum(rawBalances[currency]);
    }
    return 0;
}

function setSupplierBalance(doc, currency, value) {
    const key = normalizeCurrencyKey(currency);
    if (doc.balances instanceof Map) {
        doc.balances.set(key, value);
    } else {
        doc.balances = doc.balances || {};
        doc.balances[key] = value;
    }
    if (typeof doc.markModified === 'function') {
        doc.markModified('balances');
    }
}

async function runTreasuryTransfersTests() {
    const testUri = process.env.TEST_MONGO_URI || process.env.MONGO_URI;
    if (!testUri) {
        throw new Error('Set TEST_MONGO_URI or MONGO_URI before running tests.');
    }

    await connectDB(testUri);
    console.log('--- Connected to DB for Supplier Payments & Cash Transfers Tests ---');

    const createdIds = {
        suppliers: [],
        cashboxes: [],
        auditLogs: [],
        counterKeys: [],
    };

    try {
        const seqKey = `TR_TEST_SEQ_${Date.now()}`;
        createdIds.counterKeys.push(seqKey);

        console.log('[1/3] Testing supplier liability reduction & cashbox outflow...');
        const [supplier] = await Supplier.create([
            {
                name: `Local Supplier ${Date.now()}`,
                type: 'LOCAL',
                defaultCurrency: 'Kz',
                balances: { kz: 80000, usd: 0 },
                isActive: true,
            },
        ]);
        createdIds.suppliers.push(supplier._id);

        await Supplier.updateOne({ _id: supplier._id }, { $set: { 'balances.kz': 80000 } });

        const [sourceKzBox, targetUsdBox] = await Cashbox.create([
            {
                name: `Source Kz Box ${Date.now()}`,
                currency: 'Kz',
                balance: 100000,
                isActive: true,
            },
            {
                name: `Target USD Box ${Date.now()}`,
                currency: 'USD',
                balance: 200,
                isActive: true,
            },
        ]);
        createdIds.cashboxes.push(sourceKzBox._id, targetUsdBox._id);

        const payAmount = 25000.5;
        let paymentSeq = null;

        await runInTransaction(async (session) => {
            const freshSupplier = await Supplier.findById(supplier._id).session(session);
            const freshBox = await Cashbox.findById(sourceKzBox._id).session(session);

            const currentDebt = getSupplierBalance(freshSupplier, 'kz');
            assert(
                currentDebt >= payAmount,
                `Payment (${payAmount}) exceeds supplier Kz balance (${currentDebt})`
            );
            assertSufficientCash(freshBox.balance, payAmount, freshBox.name, freshBox.currency);

            setSupplierBalance(freshSupplier, 'kz', subMoney(currentDebt, payAmount));
            freshBox.balance = subMoney(toNum(freshBox.balance), payAmount);

            await freshSupplier.save({ session });
            await freshBox.save({ session });

            paymentSeq = await getNextSequence(seqKey, 'SUPP-PAY');
        });

        const [afterSupplier, afterSourceBox] = await Promise.all([
            Supplier.findById(supplier._id),
            Cashbox.findById(sourceKzBox._id),
        ]);

        const afterSupplierKz = getSupplierBalance(afterSupplier, 'kz');
        assert.strictEqual(afterSupplierKz, 54999.5, 'Expected supplier Kz balance to drop to 54999.5');
        assert.strictEqual(toNum(afterSourceBox.balance), 74999.5, 'Expected source Kz box balance to drop to 74999.5');

        const payAudit = await logAudit({
            entityType: 'SupplierPayment',
            entityNumber: paymentSeq,
            action: 'CREATE',
            reason: 'Verified supplier payment & cashbox deduction',
            after: {
                supplierBalance: afterSupplierKz,
                cashboxBalance: toNum(afterSourceBox.balance),
            },
        });
        if (payAudit?._id) createdIds.auditLogs.push(payAudit._id);

        console.log('[2/3] Testing cross-currency cash transfer (Kz -> USD) with FX rate...');
        const transferKz = 46000;
        const fxRate = 920; // 46000 / 920 = 50 USD
        const expectedUsd = Number(mulMoney(transferKz, 1 / fxRate).toFixed(2));
        assert.strictEqual(expectedUsd, 50);

        await runInTransaction(async (session) => {
            const freshFrom = await Cashbox.findById(sourceKzBox._id).session(session);
            const freshTo = await Cashbox.findById(targetUsdBox._id).session(session);

            assertSufficientCash(freshFrom.balance, transferKz, freshFrom.name, freshFrom.currency);

            freshFrom.balance = subMoney(toNum(freshFrom.balance), transferKz);
            freshTo.balance = addMoney(toNum(freshTo.balance), expectedUsd);

            await freshFrom.save({ session });
            await freshTo.save({ session });
        });

        const [afterTransferFrom, afterTransferTo] = await Promise.all([
            Cashbox.findById(sourceKzBox._id),
            Cashbox.findById(targetUsdBox._id),
        ]);

        assert.strictEqual(toNum(afterTransferFrom.balance), 28999.5, 'Expected Kz box to drop to 28999.5');
        assert.strictEqual(toNum(afterTransferTo.balance), 250, 'Expected USD box to rise to 250');

        console.log('[3/3] Testing atomic rollback when cash transfer fails mid-way...');
        await assert.rejects(async () => {
            await runInTransaction(async (session) => {
                const freshFrom = await Cashbox.findById(sourceKzBox._id).session(session);
                const freshTo = await Cashbox.findById(targetUsdBox._id).session(session);

                freshFrom.balance = subMoney(toNum(freshFrom.balance), 5000);
                freshTo.balance = addMoney(toNum(freshTo.balance), 5);

                await freshFrom.save({ session });
                await freshTo.save({ session });

                throw new Error('Simulated failure during cash transfer');
            });
        }, /Simulated failure during cash transfer/);

        const [afterRbFrom, afterRbTo] = await Promise.all([
            Cashbox.findById(sourceKzBox._id),
            Cashbox.findById(targetUsdBox._id),
        ]);

        assert.strictEqual(toNum(afterRbFrom.balance), 28999.5, 'Rollback failed: source Kz box changed');
        assert.strictEqual(toNum(afterRbTo.balance), 250, 'Rollback failed: target USD box changed');

        console.log('All Supplier Payments & Cash Transfers tests passed!');
    } finally {
        console.log('--- Cleaning up Treasury & Transfers test records ---');
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

runTreasuryTransfersTests().catch((err) => {
    console.error('Treasury & Transfers test failed:', err);
    process.exit(1);
});