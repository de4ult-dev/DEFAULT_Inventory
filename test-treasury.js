require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/config/db');
const Cashbox = require('./src/modules/treasury/cashbox');
const CashMove = require('./src/modules/treasury/cashMove');
const AuditLog = require('./src/shared/models/auditLog');
const Counter = require('./src/shared/models/counter');
const {
  recordCashMovement,
  transferBetweenCashboxes,
} = require('./src/modules/treasury/treasury.service');

(async () => {
  try {
    await connectDB(process.env.MONGO_URI);

    const [boxA, boxB] = await Cashbox.create([
      { name: 'Test Box A (Kz)', currency: 'Kz', balance: 0 },
      { name: 'Test Box B (Kz)', currency: 'Kz', balance: 0 },
    ]);

    await recordCashMovement({
      cashboxId: boxA._id,
      direction: 'IN',
      amount: 1000,
      currency: 'Kz',
      category: 'OPENING_BALANCE',
      referenceType: 'OPENING',
      referenceNumber: 'OPN-TEST-1',
      description: 'Test opening balance',
    });

    const transfer = await transferBetweenCashboxes({
      fromCashboxId: boxA._id,
      toCashboxId: boxB._id,
      amount: 350.5,
      description: 'Test transfer',
    });
    console.log('Transfer result:', transfer.transferNumber, transfer.amount);

    const updatedA = await Cashbox.findById(boxA._id);
    const updatedB = await Cashbox.findById(boxB._id);
    console.log('Balances -> Box A:', updatedA.balance, '| Box B:', updatedB.balance);

    try {
      await transferBetweenCashboxes({
        fromCashboxId: boxA._id,
        toCashboxId: boxB._id,
        amount: 99999,
      });
      console.error('FAIL: Overdraw should have thrown');
    } catch (err) {
      console.log('PASS overdraw guard:', err.statusCode, err.message);
    }

    await CashMove.deleteMany({ cashboxId: { $in: [boxA._id, boxB._id] } });
    await Cashbox.deleteMany({ _id: { $in: [boxA._id, boxB._id] } });
    await AuditLog.deleteMany({
      entityNumber: { $in: ['OPN-TEST-1', transfer.transferNumber] },
    });
    await Counter.deleteMany({ key: 'CASH_TRANSFER' });
  } finally {
    await mongoose.disconnect();
  }
})();