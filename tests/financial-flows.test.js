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

const Cashbox = require('../src/modules/treasury/cashbox');
const User = require('../src/modules/users/user');
const RefreshToken = require('../src/modules/auth/refreshToken');
const authService = require('../src/modules/auth/auth.service');

async function runFinancialTests() {
    const testUri = process.env.TEST_MONGO_URI || process.env.MONGO_URI;
    if (!testUri) {
        throw new Error('Set TEST_MONGO_URI or MONGO_URI before running tests.');
    }

    await connectDB(testUri);
    console.log('--- Connected to DB for Financial & Session Tests ---');

    const createdIds = {
        cashboxes: [],
        users: [],
    };

    try {
        console.log('[1/4] Testing multi-currency precision & cash guard...');
        // مثال تحويل Kz إلى USD بسعر صرف 920
        const kzAmount = 92000;
        const rate = 920;
        const usdConverted = mulMoney(kzAmount, 1 / rate);
        assert.strictEqual(Number(usdConverted.toFixed(2)), 100);

        const cashboxBalance = 15000.5;
        const expenseAmount = 4250.25;
        const expectedRemaining = subMoney(cashboxBalance, expenseAmount);
        assert.strictEqual(expectedRemaining, 10750.25);
        // رفض عملية تتجاوز الرصيد
        assert.throws(
            () => assertSufficientCash(expectedRemaining, 20000, 'Kz Main Box', 'Kz'),
            /Insufficient balance/
        );
        // قبول عملية ضمن الرصيد
        assert.doesNotThrow(() =>
            assertSufficientCash(expectedRemaining, 5000, 'Kz Main Box', 'Kz')
        );

        console.log('[2/4] Testing atomic rollback when an error occurs mid-transaction...');
        const uniqueBoxName = `Rollback Test Box ${Date.now()}`;
        await assert.rejects(async () => {
            await runInTransaction(async (session) => {
                const [box] = await Cashbox.create(
                    [{ name: uniqueBoxName, currency: 'Kz', balance: 25000, isActive: true }],
                    { session }
                );
                createdIds.cashboxes.push(box._id);

                // إجبار فشل متعمد لاختبار التراجع الذري (Rollback)
                throw new Error('Simulated failure mid-transaction');
            });
        }, /Simulated failure mid-transaction/);

        const ghostBox = await Cashbox.findOne({ name: uniqueBoxName });
        assert.strictEqual(ghostBox, null, 'Transaction did not roll back uncommitted cashbox!');

        console.log('[3/4] Testing real cashbox balance update inside transaction...');
        await runInTransaction(async (session) => {
            const [box] = await Cashbox.create(
                [{ name: `Active Flow Box ${Date.now()}`, currency: 'USD', balance: 500, isActive: true }],
                { session }
            );
            createdIds.cashboxes.push(box._id);

            const afterDeposit = addMoney(box.balance, 250.75);
            const afterWithdraw = subMoney(afterDeposit, 100.25);
            box.balance = afterWithdraw;
            await box.save({ session });

            assert.strictEqual(box.balance, 650.5);
        });

        console.log('[4/4] Testing refresh token invalidation after logout...');
        const username = `fin_tester_${Date.now()}`;
        const createdUser = await authService.registerUser({
            name: 'Financial Tester',
            username,
            password: 'Password123!',
            role: 'MANAGER',
            permissions: [],
        });
        createdIds.users.push(createdUser.id);

        const sessionTokens = await authService.login({
            username,
            password: 'Password123!',
            ip: '127.0.0.1',
        });

        const refreshed = await authService.refreshSession(sessionTokens.refreshToken);
        assert(refreshed.accessToken, 'Expected new access token before logout');

        await authService.logout(sessionTokens.refreshToken, createdUser.id);

        await assert.rejects(async () => {
            await authService.refreshSession(sessionTokens.refreshToken);
        }, /invalid|revoked|expired|unauthorized/i);

        console.log('All financial & session tests passed!');
    } finally {
        console.log('--- Cleaning up financial test records ---');
        if (createdIds.cashboxes.length) {
            await Cashbox.deleteMany({ _id: { $in: createdIds.cashboxes } });
        }
        if (createdIds.users.length) {
            await RefreshToken.deleteMany({ userId: { $in: createdIds.users } });
            await User.deleteMany({ _id: { $in: createdIds.users } });
        }
        await disconnectDB();
    }
}

runFinancialTests().catch((err) => {
    console.error('Financial test failed:', err);
    process.exit(1);
});