require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/config/db');
const Customer = require('./src/modules/customers');
const Cashbox = require('./src/modules/treasury/cashbox');
const CashMove = require('./src/modules/treasury/cashMove');
const Collection = require('./src/modules/collections/collection');
const AuditLog = require('./src/shared/models/auditLog');
const Counter = require('./src/shared/models/counter');
const { createCollection } = require('./src/modules/collections/collections.service');

(async () => {
    let usdBox = null;
    let kzBox = null;
    let customer = null;
    const createdReceipts = [];

    try {
        await connectDB(process.env.MONGO_URI);

        [usdBox, kzBox] = await Cashbox.create([
            { name: 'Test Collection USD Box', currency: 'USD', balance: 0 },
            { name: 'Test Collection Kz Box', currency: 'Kz', balance: 0 },
        ]);

        customer = await Customer.create({
            name: 'Test Collection Angola Customer',
            type: 'CREDIT',
            balances: { usd: 2000, kz: 531000 },
            creditBalances: { usd: 0, kz: 0 },
        });

        // Case 1: Pay 1,300,000 Kz into Kz box at manual rate 1,300 (Kz per USD) -> settles 1,000 USD debt
        const res1 = await createCollection({
            customerId: customer._id,
            cashboxId: kzBox._id,
            amount: 1300000,
            paymentCurrency: 'Kz',
            debtCurrency: 'USD',
            exchangeRate: 1300,
            notes: 'Pay USD debt using Kz',
        });
        createdReceipts.push(res1.collection.number);

        console.log('After RCT-1 (1,300,000 Kz @ 1,300 -> USD debt):');
        console.log('  Receipt:', res1.collection.number, '| Settled:', res1.collection.settledAmount, res1.collection.debtCurrency);
        console.log('  Customer balances:', res1.customer.balances);
        console.log('  Kz cashbox:', (await Cashbox.findById(kzBox._id)).balance);

        // Case 2: Pay 200 USD into USD box at manual rate 1,300 (Kz per USD) -> settles 260,000 Kz debt
        const res2 = await createCollection({
            customerId: customer._id,
            cashboxId: usdBox._id,
            amount: 200,
            paymentCurrency: 'USD',
            debtCurrency: 'Kz',
            exchangeRate: 1300,
            notes: 'Pay Kz debt using USD',
        });
        createdReceipts.push(res2.collection.number);

        console.log('After RCT-2 (200 USD @ 1,300 -> Kz debt):');
        console.log('  Receipt:', res2.collection.number, '| Settled:', res2.collection.settledAmount, res2.collection.debtCurrency);
        console.log('  Customer balances:', res2.customer.balances);
        console.log('  USD cashbox:', (await Cashbox.findById(usdBox._id)).balance);
    } finally {
        if (createdReceipts.length > 0) {
            await Collection.deleteMany({ number: { $in: createdReceipts } });
            await AuditLog.deleteMany({ entityNumber: { $in: createdReceipts } });
        }
        if (usdBox || kzBox) {
            const boxIds = [usdBox?._id, kzBox?._id].filter(Boolean);
            await CashMove.deleteMany({ cashboxId: { $in: boxIds } });
            await Cashbox.deleteMany({ _id: { $in: boxIds } });
        }
        if (customer) {
            await Customer.deleteOne({ _id: customer._id });
        }
        await Counter.deleteMany({ key: 'COLLECTION' });
        await mongoose.disconnect();
    }
})();