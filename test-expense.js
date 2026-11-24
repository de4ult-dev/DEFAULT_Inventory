require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/config/db');
const Cashbox = require('./src/modules/treasury/cashbox');
const CashMove = require('./src/modules/treasury/cashMove');
const Expense = require('./src/modules/expenses/expense');
const AuditLog = require('./src/shared/models/auditLog');
const Counter = require('./src/shared/models/counter');
const { createExpense } = require('./src/modules/expenses/expenses.service');

(async () => {
    let kzBox = null;
    let usdBox = null;
    const createdExpenses = [];

    try {
        await connectDB(process.env.MONGO_URI);

        [kzBox, usdBox] = await Cashbox.create([
            { name: 'Test Expense Kz Box', currency: 'Kz', balance: 1000000 },
            { name: 'Test Expense USD Box', currency: 'USD', balance: 500 },
        ]);

        // 1. Same-currency lump-sum expense (150,000 Kz from Kz cashbox)
        const exp1 = await createExpense({
            category: 'RENT',
            amount: 150000,
            currency: 'Kz',
            cashboxId: kzBox._id,
            isLumpSum: true,
            description: 'Warehouse monthly rent',
        });
        createdExpenses.push(exp1.expense.number);

        // 2. Cross-currency expense (100,000 Kz expense paid from USD cashbox @ 1,000 -> 100 USD)
        const exp2 = await createExpense({
            category: 'TRANSPORT',
            amount: 100000,
            currency: 'Kz',
            cashboxId: usdBox._id,
            exchangeRate: 1000,
            isLumpSum: true,
            description: 'Local transport paid in USD',
        });
        createdExpenses.push(exp2.expense.number);

        // 3. Insufficient balance check (should fail cleanly)
        let insufficientError = null;
        try {
            await createExpense({
                category: 'SALARIES',
                amount: 900000,
                currency: 'Kz',
                cashboxId: kzBox._id,
            });
        } catch (err) {
            insufficientError = err.message;
        }

        console.log('EXP-1:', exp1.expense.number, '| Paid:', exp1.expense.paidAmount, exp1.expense.paidCurrency, '| Kz box:', exp1.cashbox.balance);
        console.log('EXP-2:', exp2.expense.number, '| Paid:', exp2.expense.paidAmount, exp2.expense.paidCurrency, '| USD box:', exp2.cashbox.balance);
        console.log('Insufficient balance check:', insufficientError);
    } finally {
        if (createdExpenses.length > 0) {
            await Expense.deleteMany({ number: { $in: createdExpenses } });
            await AuditLog.deleteMany({ entityNumber: { $in: createdExpenses } });
        }
        const boxIds = [kzBox?._id, usdBox?._id].filter(Boolean);
        if (boxIds.length > 0) {
            await CashMove.deleteMany({ cashboxId: { $in: boxIds } });
            await Cashbox.deleteMany({ _id: { $in: boxIds } });
        }
        await Counter.deleteMany({ key: 'EXPENSE' });
        await mongoose.disconnect();
    }
})();