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
const { assertValidCurrency, assertSufficientCash } = require('../src/shared/utils/guards');
const { logAudit } = require('../src/shared/services/audit.service');
const { getNextSequence } = require('../src/shared/services/sequence.service');
const { authMiddleware } = require('../src/shared/middlewares/auth.middleware');

const User = require('../src/modules/users/user');
const RefreshToken = require('../src/modules/auth/refreshToken');
const authService = require('../src/modules/auth/auth.service');

const Cashbox = require('../src/modules/treasury/cashbox');
const Product = require('../src/modules/inventory/product');
const Expense = require('../src/modules/expenses/expense');
const AuditLog = require('../src/shared/models/auditLog');
const Counter = require('../src/shared/models/counter');

function createMockRes() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
    };
}

async function runDeepTests() {
    const testUri = process.env.TEST_MONGO_URI || process.env.MONGO_URI;
    if (!testUri) {
        throw new Error('Set TEST_MONGO_URI or MONGO_URI before running tests.');
    }

    await connectDB(testUri);
    console.log('--- Connected to DB for Deep ERP Tests ---');

    const createdIds = {
        users: [],
        cashboxes: [],
        products: [],
        expenses: [],
        auditLogs: [],
        counterKeys: [],
    };

    try {
        console.log('[1/5] Testing concurrent sequence generation (no duplicates)...');
        const concKey = `CONC_SEQ_${Date.now()}`;
        createdIds.counterKeys.push(concKey);

        const generatedNumbers = await Promise.all([
            getNextSequence(concKey, 'INV'),
            getNextSequence(concKey, 'INV'),
            getNextSequence(concKey, 'INV'),
            getNextSequence(concKey, 'INV'),
            getNextSequence(concKey, 'INV'),
        ]);

        assert.deepStrictEqual(
            [...generatedNumbers].sort(),
            [
                'INV-000001',
                'INV-000002',
                'INV-000003',
                'INV-000004',
                'INV-000005',
            ]
        );
        assert.strictEqual(new Set(generatedNumbers).size, 5, 'Duplicate sequence numbers detected!');
        console.log('[2/5] Testing Kz <-> USD multi-step arithmetic & precision...');
        const usdToKz = mulMoney(150.5, 920); // 138460
        assert.strictEqual(usdToKz, 138460);

        const partialSettlementKz = 45000.75;
        const remainingKz = subMoney(usdToKz, partialSettlementKz);
        assert.strictEqual(remainingKz, 93459.25);

        const combinedTotal = addMoney(remainingKz, partialSettlementKz);
        assert.strictEqual(combinedTotal, 138460);

        assert.strictEqual(assertValidCurrency('kZ'), 'Kz');
        assert.strictEqual(assertValidCurrency('usd'), 'USD');

        console.log('[3/5] Testing multi-entity atomic rollback (Cashbox + Product + Expense)...');
        const rollbackTag = `RB_${Date.now()}`;
        await assert.rejects(async () => {
            await runInTransaction(async (session) => {
                const [box] = await Cashbox.create(
                    [{ name: `Box ${rollbackTag}`, currency: 'Kz', balance: 100000, isActive: true }],
                    { session }
                );
                createdIds.cashboxes.push(box._id);

                const [prod] = await Product.create(
                    [
                        {
                            sku: `SKU-${rollbackTag}`,
                            name: `Prod ${rollbackTag}`,
                            currency: 'Kz',
                            prices: { cash: 5000, credit: 5500, wholesale: 4500 },
                            cost: 2500,
                            stock: { available: 50, damaged: 0 },
                            isActive: true,
                        },
                    ],
                    { session }
                );
                createdIds.products.push(prod._id);

                assertSufficientCash(box.balance, 20000, box.name, box.currency);
                const nextBalance = subMoney(box.balance, 20000);
                box.balance = nextBalance;
                await box.save({ session });

                const [exp] = await Expense.create(
    [
        {
            number: `EXP-${rollbackTag}`,
            category: 'TRANSPORT',
            status: 'POSTED',
            amount: 20000,
            currency: 'Kz',
            cashboxId: box._id,
            cashboxNameSnapshot: box.name,
            paidAmount: 20000,
            paidCurrency: 'Kz',
            exchangeRate: 1,
        },
    ],
    { session }
);
                createdIds.expenses.push(exp._id);

                // فشل مقصود بعد كتابة 3 كيانات للتحقق من تراجع الكل معاً
                throw new Error('Forced failure after writing Cashbox, Product, and Expense');
            });
        }, /Forced failure after writing Cashbox, Product, and Expense/);

        const [leakedBox, leakedProd, leakedExp] = await Promise.all([
            Cashbox.findOne({ name: `Box ${rollbackTag}` }),
            Product.findOne({ sku: `SKU-${rollbackTag}` }),
            Expense.findOne({ number: `EXP-${rollbackTag}` }),
        ]);
        assert.strictEqual(leakedBox, null, 'Leaked Cashbox after rollback');
        assert.strictEqual(leakedProd, null, 'Leaked Product after rollback');
        assert.strictEqual(leakedExp, null, 'Leaked Expense after rollback');

        console.log('[4/5] Testing AuditLog persistence & cleanup...');
        const auditRecord = await logAudit({
            entityType: 'DeepTest',
            entityNumber: `AUDIT-${Date.now()}`,
            action: 'CREATE',
            reason: 'Deep ERP test audit entry',
            after: { verified: true, currencies: ['Kz', 'USD'] },
        });
        assert(auditRecord && auditRecord._id, 'Expected AuditLog document with _id');
        createdIds.auditLogs.push(auditRecord._id);

        console.log('[5/5] Testing Auth & Middleware negative/edge cases...');
        const edgeUsername = `deep_edge_${Date.now()}`;
        const user = await authService.registerUser({
            name: 'Edge Case Tester',
            username: edgeUsername,
            password: 'StrongPassword123!',
            role: 'MANAGER',
            permissions: [],
        });
        createdIds.users.push(user.id);

        // 1) كلمة مرور خاطئة يجب أن تُرفض
        await assert.rejects(async () => {
            await authService.login({
                username: edgeUsername,
                password: 'WrongPassword999!',
                ip: '127.0.0.1',
            });
        }, /invalid|credentials|password|unauthorized/i);

        // 2) refreshToken تالف يجب أن يُرفض
        await assert.rejects(async () => {
            await authService.refreshSession('invalid.refresh.token.value');
        }, /invalid|malformed|expired|jwt|unauthorized/i);

        // 3) طلب بدون Authorization header يجب أن يرفضه authMiddleware
        const noAuthReq = { headers: {} };
        const noAuthRes = createMockRes();
        let nextCalledForMissingToken = false;
        await authMiddleware(noAuthReq, noAuthRes, () => {
            nextCalledForMissingToken = true;
        });
        assert.strictEqual(nextCalledForMissingToken, false, 'Middleware should block missing token');
        assert(noAuthRes.statusCode >= 400, `Expected 4xx status, got ${noAuthRes.statusCode}`);

        // 4) token مزوّر يجب أن يرفضه authMiddleware
        const badTokenReq = { headers: { authorization: 'Bearer fake.jwt.token' } };
        const badTokenRes = createMockRes();
        let nextCalledForBadToken = false;
        await authMiddleware(badTokenReq, badTokenRes, () => {
            nextCalledForBadToken = true;
        });
        assert.strictEqual(nextCalledForBadToken, false, 'Middleware should block malformed token');
        assert(badTokenRes.statusCode >= 400, `Expected 4xx status, got ${badTokenRes.statusCode}`);

        console.log('All deep ERP tests passed!');
    } finally {
        console.log('--- Cleaning up deep test records ---');
        if (createdIds.users.length) {
            await RefreshToken.deleteMany({ userId: { $in: createdIds.users } });
            await User.deleteMany({ _id: { $in: createdIds.users } });
        }
        if (createdIds.cashboxes.length) {
            await Cashbox.deleteMany({ _id: { $in: createdIds.cashboxes } });
        }
        if (createdIds.products.length) {
            await Product.deleteMany({ _id: { $in: createdIds.products } });
        }
        if (createdIds.expenses.length) {
            await Expense.deleteMany({ _id: { $in: createdIds.expenses } });
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

runDeepTests().catch((err) => {
    console.error('Deep ERP test failed:', err);
    process.exit(1);
});