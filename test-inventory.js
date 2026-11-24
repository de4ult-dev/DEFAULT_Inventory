require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/config/db');
const Product = require('./src/modules/inventory/product');
const StockMove = require('./src/modules/inventory/stockMove');
const AuditLog = require('./src/shared/models/auditLog');
const Counter = require('./src/shared/models/counter');
const {
  receiveStock,
  deductStock,
  reclassifyDamagedStock,
} = require('./src/modules/inventory/inventory.service');

(async () => {
  try {
    await connectDB(process.env.MONGO_URI);

    const product = await Product.create({
      sku: 'SKU-TEST-AVG-01',
      name: 'Test Item Avg Cost',
      currency: 'Kz',
      prices: { cash: 300, credit: 320, wholesale: 280 },
      cost: 0,
      stock: { available: 0, damaged: 0 },
    });

    // 1. Receive 10 @ 100 Kz -> available: 10, cost: 100
    await receiveStock({
      productId: product._id,
      quantity: 10,
      unitCost: 100,
      currency: 'Kz',
      referenceType: 'PURCHASE',
      referenceNumber: 'PUR-TEST-1',
    });

    // 2. Receive 10 @ 200 Kz -> available: 20, moving avg cost: 150
    const afterSecondReceipt = await receiveStock({
      productId: product._id,
      quantity: 10,
      unitCost: 200,
      currency: 'Kz',
      referenceType: 'PURCHASE',
      referenceNumber: 'PUR-TEST-2',
    });
    console.log(
      'After 2 receipts -> available:',
      afterSecondReceipt.product.stock.available,
      '| avg cost:',
      afterSecondReceipt.product.cost
    );

    // 3. Deduct 5 available -> available: 15, cost stays 150
    const afterDeduct = await deductStock({
      productId: product._id,
      quantity: 5,
      currency: 'Kz',
      referenceType: 'INVOICE',
      referenceNumber: 'INV-TEST-1',
    });
    console.log(
      'After deduct 5 -> available:',
      afterDeduct.product.stock.available,
      '| cost:',
      afterDeduct.product.cost
    );

    // 4. Reclassify 3 to DAMAGED -> available: 12, damaged: 3
    const reclass = await reclassifyDamagedStock({
      productId: product._id,
      quantity: 3,
      direction: 'TO_DAMAGED',
      reason: 'Damaged in handling',
    });
    console.log(
      'After reclassify -> adj:',
      reclass.adjustmentNumber,
      '| available:',
      reclass.product.stock.available,
      '| damaged:',
      reclass.product.stock.damaged
    );

    // 5. Verify over-deduction fails with 400
    try {
      await deductStock({
        productId: product._id,
        quantity: 999,
        currency: 'Kz',
        referenceType: 'INVOICE',
        referenceNumber: 'INV-TEST-FAIL',
      });
      console.error('FAIL: Over-deduction should have thrown');
    } catch (err) {
      console.log('PASS over-deduction guard:', err.statusCode, err.message);
    }

    // Cleanup test documents
    await StockMove.deleteMany({ productId: product._id });
    await Product.deleteOne({ _id: product._id });
    await AuditLog.deleteMany({
      entityNumber: {
        $in: ['PUR-TEST-1', 'PUR-TEST-2', 'INV-TEST-1', 'INV-TEST-FAIL', reclass.adjustmentNumber],
      },
    });
    await Counter.deleteMany({ key: 'STOCK_ADJ' });
  } finally {
    await mongoose.disconnect();
  }
})();