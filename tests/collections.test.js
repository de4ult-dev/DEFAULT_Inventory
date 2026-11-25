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
const { addMoney, subMoney } = require('../src/shared/utils/money');
const { getNextSequence } = require('../src/shared/services/sequence.service');
const { logAudit } = require('../src/shared/services/audit.service');

const Customer = require('../src/modules/customers/customer');
const Cashbox = require('../src/modules/treasury/cashbox');
const Collection = require('../src/modules/collections/collection');
const AuditLog = require('../src/shared/models/auditLog');
const Counter = require('../src/shared/models/counter');

function toNum(val) {
    if (val === null || val === undefined) return 0;
    if (typeof val === 'object' && typeof val.toString === 'function') {
        return Number(val.toString());
    }
    return Number(val);
}

function getCustomerBalance(doc, currency) {
    const key = String(currency || '').toLowerCase();
    const obj = doc.toObject ? doc.toObject() : doc;
    const rawBalances = obj.balances instanceof Map ? Object.fromEntries(obj.balances) : obj.balances;
    if (rawBalances && typeof rawBalances === 'object') {
        if (key in rawBalances) return toNum(rawBalances[key]);
        if (currency in rawBalances) return toNum(rawBalances[currency]);
    }
    return 0;
}

function setCustomerBalance(doc, currency, value) {
    const key = String(currency || '').toLowerCase();
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

async function runCollectionsTests() {
    const testUri = process.env.TEST_MONGO_URI || process.env.MONGO_URI;
    if (!testUri) {
        throw new Error('Set TEST_MONGO_URI or MONGO_URI before running tests.');
    }

    await connectDB(testUri);
    console.log('--- Connected to DB for Collections Tests ---');

    const createdIds = {
        customers: [],
        cashboxes: [],
        collections: [],
        auditLogs: [],
        counterKeys: [],
    };

    try {
        const seqKey = `COL_TEST_SEQ_${Date.now()}`;
        createdIds.counterKeys.push(seqKey);

        console.log('[1/3] Testing valid customer collection, debt reduction & cashbox inflow...');
        const [customer] = await Customer.create([
            {
                name: `Test Customer ${Date.now()}`,
                phone: `+244900${Math.floor(100000 + Math.random() * 899999)}`,
                tier: 'CREDIT',
                balances: { kz: 50000, usd: 400 },
                isActive: true,
            },
        ]);
        createdIds.customers.push(customer._id);

        await Customer.updateOne(
            { _id: customer._id },
            { $set: { 'balances.kz': 50000, 'balances.usd': 400 } }
        );

        const [kzBox] = await Cashbox.create([
            {
                name: `Collections Kz Box ${Date.now()}`,
                currency: 'Kz',
                balance: 10000,
                isActive: true,
            },
        ]);
        createdIds.cashboxes.push(kzBox._id);

        const collectAmount = 15000.5;
        let savedCollectionId = null;

        await runInTransaction(async (session) => {
            const freshCustomer = await Customer.findById(customer._id).session(session);
            const freshBox = await Cashbox.findById(kzBox._id).session(session);

            const currentDebt = getCustomerBalance(freshCustomer, 'kz');
            assert(
                currentDebt >= collectAmount,
                `Collection amount (${collectAmount}) exceeds customer Kz balance (${currentDebt})`
            );

            setCustomerBalance(freshCustomer, 'kz', subMoney(currentDebt, collectAmount));
            freshBox.balance = addMoney(toNum(freshBox.balance), collectAmount);

            await freshCustomer.save({ session });
            await freshBox.save({ session });

            const colNumber = await getNextSequence(seqKey, 'COL');
            const [colDoc] = await Collection.create(
                [
                    {
                        number: colNumber,
                        status: 'POSTED',
                        customerId: freshCustomer._id,
                        customerNameSnapshot: freshCustomer.name,
                        cashboxId: freshBox._id,
                        cashboxNameSnapshot: freshBox.name,
                        originalAmount: collectAmount,
                        settledAmount: collectAmount,
                        cashboxAmount: collectAmount,
                        debtCurrency: 'Kz',
                        paymentCurrency: 'Kz',
                        cashboxCurrency: 'Kz',
                        exchangeRate: 1,
                        notes: 'Partial Kz debt collection test',
                    },
                ],
                { session }
            );
            savedCollectionId = colDoc._id;
            createdIds.collections.push(colDoc._id);
        });

        const [afterCustomer, afterBox, savedCollection] = await Promise.all([
            Customer.findById(customer._id),
            Cashbox.findById(kzBox._id),
            Collection.findById(savedCollectionId),
        ]);

        assert.strictEqual(getCustomerBalance(afterCustomer, 'kz'), 34999.5, 'Expected customer Kz balance to drop to 34999.5');
        assert.strictEqual(getCustomerBalance(afterCustomer, 'usd'), 400, 'Expected customer USD balance to remain 400');
        assert.strictEqual(toNum(afterBox.balance), 25000.5, 'Expected cashbox Kz balance to rise to 25000.5');
        assert(savedCollection, 'Expected Collection document to be persisted');

        const auditDoc = await logAudit({
            entityType: 'Collection',
            entityNumber: savedCollection.number,
            action: 'CREATE',
            reason: 'Verified customer collection flow',
            after: {
                customerKz: getCustomerBalance(afterCustomer, 'kz'),
                cashboxKz: toNum(afterBox.balance),
            },
        });
        if (auditDoc?._id) createdIds.auditLogs.push(auditDoc._id);

        console.log('[2/3] Testing rejection when collection amount exceeds customer balance...');
        await assert.rejects(async () => {
            await runInTransaction(async (session) => {
                const freshCustomer = await Customer.findById(customer._id).session(session);
                const debt = getCustomerBalance(freshCustomer, 'kz');
                const overAmount = debt + 5000;
                if (overAmount > debt) {
                    throw new Error('Collection exceeds customer outstanding balance');
                }
            });
        }, /Collection exceeds customer outstanding balance/);

        const [checkCustAfterReject, checkBoxAfterReject] = await Promise.all([
            Customer.findById(customer._id),
            Cashbox.findById(kzBox._id),
        ]);
        assert.strictEqual(getCustomerBalance(checkCustAfterReject, 'kz'), 34999.5);
        assert.strictEqual(toNum(checkBoxAfterReject.balance), 25000.5);

        console.log('[3/3] Testing atomic rollback when an error occurs mid-collection...');
        const rbNumber = `COL-RB-${Date.now()}`;
        await assert.rejects(async () => {
            await runInTransaction(async (session) => {
                const freshCustomer = await Customer.findById(customer._id).session(session);
                const freshBox = await Cashbox.findById(kzBox._id).session(session);

                const debt = getCustomerBalance(freshCustomer, 'kz');
                setCustomerBalance(freshCustomer, 'kz', subMoney(debt, 10000));
                freshBox.balance = addMoney(toNum(freshBox.balance), 10000);

                await freshCustomer.save({ session });
                await freshBox.save({ session });

                const [rbCol] = await Collection.create(
                    [
                        {
                            number: rbNumber,
                            status: 'POSTED',
                            customerId: freshCustomer._id,
                            customerNameSnapshot: freshCustomer.name,
                            cashboxId: freshBox._id,
                            cashboxNameSnapshot: freshBox.name,
                            originalAmount: 10000,
                            settledAmount: 10000,
                            cashboxAmount: 10000,
                            debtCurrency: 'Kz',
                            paymentCurrency: 'Kz',
                            cashboxCurrency: 'Kz',
                            exchangeRate: 1,
                            notes: 'Should roll back',
                        },
                    ],
                    { session }
                );
                createdIds.collections.push(rbCol._id);

                throw new Error('Simulated failure mid-collection');
            });
        }, /Simulated failure mid-collection/);

        const [afterRbCustomer, afterRbBox, leakedRbCol] = await Promise.all([
            Customer.findById(customer._id),
            Cashbox.findById(kzBox._id),
            Collection.findOne({ number: rbNumber }),
        ]);

        assert.strictEqual(getCustomerBalance(afterRbCustomer, 'kz'), 34999.5, 'Rollback failed: customer Kz changed');
        assert.strictEqual(toNum(afterRbBox.balance), 25000.5, 'Rollback failed: cashbox Kz changed');
        assert.strictEqual(leakedRbCol, null, 'Rollback failed: rolled-back Collection still exists');

        console.log('All Collections tests passed!');
    } finally {
        console.log('--- Cleaning up Collections test records ---');
        if (createdIds.collections.length) {
            await Collection.deleteMany({ _id: { $in: createdIds.collections } });
        }
        if (createdIds.customers.length) {
            await Customer.deleteMany({ _id: { $in: createdIds.customers } });
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

runCollectionsTests().catch((err) => {
    console.error('Collections test failed:', err);
    process.exit(1);
});