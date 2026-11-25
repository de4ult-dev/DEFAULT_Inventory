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
const Collection = require('../src/modules/collections/collection');
const ProductExchange = require('../src/modules/exchanges/productExchange');
const Customer = require('../src/modules/customers/customer');

const AuditLog = require('../src/shared/models/auditLog');
const Counter = require('../src/shared/models/counter');

const dashboardService = require('../src/modules/dashboards/dashboard.service');
const reportsService = require('../src/modules/reports/reports.service');

async function runTests() {
    const testUri = process.env.TEST_MONGO_URI || process.env.MONGO_URI;
    if (!testUri) {
        throw new Error('Set TEST_MONGO_URI or MONGO_URI before running tests.');
    }

    await connectDB(testUri);
    console.log('--- Connected to DB for ERP Smoke Tests ---');

    const createdIds = {
        users: [],
        customers: [],
        cashboxes: [],
        products: [],
        expenses: [],
        collections: [],
        exchanges: [],
        auditLogs: [],
        counterKeys: [],
    };

    try {
        console.log('[1/6] Testing money & guards...');
        assert.strictEqual(addMoney(0.1, 0.2), 0.3);
        assert.strictEqual(subMoney(100, 33.33), 66.67);
        assert.strictEqual(mulMoney(12.5, 4), 50);
        assert.strictEqual(assertValidCurrency('kz'), 'Kz');
        assert.strictEqual(assertValidCurrency('USD'), 'USD');
        assert.throws(() => assertValidCurrency('EUR'), /Invalid currency/);
        assert.throws(() => assertSufficientCash(50, 80, 'Main Kz', 'Kz'), /Insufficient balance/);

        console.log('[2/6] Testing sequence & audit log...');
        const seqKey = `TEST_SEQ_${Date.now()}`;
        createdIds.counterKeys.push(seqKey);
        const seq1 = await getNextSequence(seqKey, 'TST');
        const seq2 = await getNextSequence(seqKey, 'TST');
        assert.strictEqual(seq1, 'TST-000001');
        assert.strictEqual(seq2, 'TST-000002');

        const auditDoc = await logAudit({
            entityType: 'SmokeTest',
            entityNumber: seq1,
            action: 'CREATE',
            reason: 'Smoke test audit check',
            after: { ok: true },
        });
        if (auditDoc?._id) createdIds.auditLogs.push(auditDoc._id);

        console.log('[3/6] Testing Auth (bcrypt, JWT, refresh, logout, middleware)...');
        const uniqueUser = `smoke_user_${Date.now()}`;
        const registered = await authService.registerUser({
            name: 'Smoke Tester',
            username: uniqueUser,
            password: 'Password123!',
            role: 'MANAGER',
            permissions: ['APPROVE_EXPENSE'],
        });
        createdIds.users.push(registered.id);

        const loginData = await authService.login({
            username: uniqueUser,
            password: 'Password123!',
            ip: '127.0.0.1',
        });
        assert(loginData.accessToken, 'Missing accessToken');
        assert(loginData.refreshToken, 'Missing refreshToken');

        const req = { headers: { authorization: `Bearer ${loginData.accessToken}` } };
        let statusCode = 200;
        let jsonBody = null;
        const res = {
            status(code) {
                statusCode = code;
                return this;
            },
            json(body) {
                jsonBody = body;
                return this;
            },
        };
        let nextCalled = false;
        await authMiddleware(req, res, () => {
            nextCalled = true;
        });
        assert.strictEqual(
            nextCalled,
            true,
            `authMiddleware failed: ${statusCode} ${JSON.stringify(jsonBody)}`
        );
        assert.strictEqual(req.user.username, uniqueUser);

        const refreshed = await authService.refreshSession(loginData.refreshToken);
        assert(refreshed.accessToken, 'Missing refreshed accessToken');

        await authService.logout(loginData.refreshToken, registered.id);

        console.log('[4/6] Testing core models & atomic transaction...');
        await runInTransaction(async (session) => {
            const [kzBox] = await Cashbox.create(
                [{ name: `Smoke Kz Box ${Date.now()}`, currency: 'Kz', balance: 50000, isActive: true }],
                { session }
            );
            const [usdBox] = await Cashbox.create(
                [{ name: `Smoke USD Box ${Date.now()}`, currency: 'USD', balance: 1000, isActive: true }],
                { session }
            );
            createdIds.cashboxes.push(kzBox._id, usdBox._id);

            const [cust] = await Customer.create(
                [{ name: `Smoke Customer ${Date.now()}`, isActive: true }],
                { session }
            );
            createdIds.customers.push(cust._id);

            const [prodA] = await Product.create(
                [
                    {
                        sku: `SKU-A-${Date.now()}`,
                        name: 'Product A',
                        currency: 'Kz',
                        prices: { cash: 1000, credit: 1100, wholesale: 900 },
                        cost: 500,
                        stock: { available: 20, damaged: 2 },
                        isActive: true,
                    },
                ],
                { session }
            );
            const [prodB] = await Product.create(
                [
                    {
                        sku: `SKU-B-${Date.now()}`,
                        name: 'Product B',
                        currency: 'Kz',
                        prices: { cash: 2000, credit: 2200, wholesale: 1800 },
                        cost: 1000,
                        stock: { available: 10, damaged: 0 },
                        isActive: true,
                    },
                ],
                { session }
            );
            createdIds.products.push(prodA._id, prodB._id);

            const [exp] = await Expense.create(
                [
                    {
                        number: `EXP-TEST-${Date.now()}`,
                        category: 'TRANSPORT',
                        status: 'POSTED',
                        amount: 5000,
                        currency: 'Kz',
                        cashboxId: kzBox._id,
                        cashboxNameSnapshot: kzBox.name,
                        paidAmount: 5000,
                        paidCurrency: 'Kz',
                        exchangeRate: 1,
                    },
                ],
                { session }
            );
            createdIds.expenses.push(exp._id);

            const [col] = await Collection.create(
                [
                    {
                        number: `COL-TEST-${Date.now()}`,
                        status: 'POSTED',
                        customerId: cust._id,
                        customerNameSnapshot: cust.name,
                        cashboxId: usdBox._id,
                        paymentCurrency: 'USD',
                        debtCurrency: 'USD',
                        cashboxCurrency: 'USD',
                        originalAmount: 100,
                        exchangeRate: 1,
                        settledAmount: 100,
                        cashboxAmount: 100,
                    },
                ],
                { session }
            );
            createdIds.collections.push(col._id);

            const [ex] = await ProductExchange.create(
                [
                    {
                        number: `EX-TEST-${Date.now()}`,
                        status: 'POSTED',
                        outgoing: {
                            productId: prodA._id,
                            skuSnapshot: prodA.sku,
                            nameSnapshot: prodA.name,
                            stockBucket: 'AVAILABLE',
                            quantity: 2,
                            unitCost: 500,
                            currency: 'Kz',
                            totalValue: 1000,
                        },
                        incoming: {
                            productId: prodB._id,
                            skuSnapshot: prodB.sku,
                            nameSnapshot: prodB.name,
                            stockBucket: 'AVAILABLE',
                            quantity: 1,
                            unitCost: 1000,
                            currency: 'Kz',
                            totalValue: 1000,
                        },
                        exchangeRate: 1,
                        reason: 'Customer swap',
                    },
                ],
                { session }
            );
            createdIds.exchanges.push(ex._id);
        });

        console.log('[5/6] Testing Dashboard & Reports services...');
        const dash = await dashboardService.getDashboardSummary();
        assert(dash && dash.cashBalances && dash.customerReceivables, 'Invalid dashboard summary');

        const salesRep = await reportsService.getSalesReport({});
        const expRep = await reportsService.getExpensesReport({});
        const colRep = await reportsService.getCollectionsReport({});
        assert(typeof salesRep.count === 'number');
        assert(typeof expRep.count === 'number');
        assert(typeof colRep.count === 'number');

        console.log('[6/6] All smoke checks passed successfully!');
    } finally {
        console.log('--- Cleaning up smoke test records ---');
        if (createdIds.users.length) {
            await RefreshToken.deleteMany({ userId: { $in: createdIds.users } });
            await User.deleteMany({ _id: { $in: createdIds.users } });
        }
        if (createdIds.customers.length) await Customer.deleteMany({ _id: { $in: createdIds.customers } });
        if (createdIds.cashboxes.length) await Cashbox.deleteMany({ _id: { $in: createdIds.cashboxes } });
        if (createdIds.products.length) await Product.deleteMany({ _id: { $in: createdIds.products } });
        if (createdIds.expenses.length) await Expense.deleteMany({ _id: { $in: createdIds.expenses } });
        if (createdIds.collections.length) await Collection.deleteMany({ _id: { $in: createdIds.collections } });
        if (createdIds.exchanges.length) await ProductExchange.deleteMany({ _id: { $in: createdIds.exchanges } });
        if (createdIds.auditLogs.length) await AuditLog.deleteMany({ _id: { $in: createdIds.auditLogs } });
        if (createdIds.counterKeys.length) await Counter.deleteMany({ key: { $in: createdIds.counterKeys } });

        await disconnectDB();
    }
}

runTests().catch((err) => {
    console.error('Smoke test failed:', err);
    process.exit(1);
});