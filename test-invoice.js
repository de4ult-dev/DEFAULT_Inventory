require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/config/db');
const Customer = require('./src/modules/customers');
const Product = require('./src/modules/inventory/product');
const StockMove = require('./src/modules/inventory/stockMove');
const Cashbox = require('./src/modules/treasury/cashbox');
const CashMove = require('./src/modules/treasury/cashMove');
const Invoice = require('./src/modules/invoices/invoice');
const InvoiceItem = require('./src/modules/invoices/invoiceItems');
const Payment = require('./src/modules/invoices/payment');
const AuditLog = require('./src/shared/models/auditLog');
const Counter = require('./src/shared/models/counter');
const { receiveStock } = require('./src/modules/inventory/inventory.service');
const { createInvoice } = require('./src/modules/invoices/invoice.service');

(async () => {
  let createdInvoice = null;
  let createdPayments = [];
  let usdBox = null;
  let kzBox = null;
  let usdProd = null;
  let kzProd = null;
  let customer = null;

  try {
    await connectDB(process.env.MONGO_URI);

    [usdBox, kzBox] = await Cashbox.create([
      { name: 'Test USD Box', currency: 'USD', balance: 0 },
      { name: 'Test Kz Box', currency: 'Kz', balance: 0 },
    ]);

    [usdProd, kzProd] = await Product.create([
      {
        sku: 'SKU-IMP-USD-01',
        name: 'Imported Item USD',
        currency: 'USD',
        prices: { cash: 100, credit: 110, wholesale: 90 },
        cost: 0,
        stock: { available: 0, damaged: 0 },
      },
      {
        sku: 'SKU-LOC-KZ-01',
        name: 'Local Item Kz',
        currency: 'Kz',
        prices: { cash: 5000, credit: 5500, wholesale: 4500 },
        cost: 0,
        stock: { available: 0, damaged: 0 },
      },
    ]);

    await receiveStock({
      productId: usdProd._id,
      quantity: 10,
      unitCost: 60,
      currency: 'USD',
      referenceType: 'PURCHASE',
      referenceNumber: 'PUR-INV-TEST-USD',
    });

    await receiveStock({
      productId: kzProd._id,
      quantity: 20,
      unitCost: 3000,
      currency: 'Kz',
      referenceType: 'PURCHASE',
      referenceNumber: 'PUR-INV-TEST-KZ',
    });

    customer = await Customer.create({
      name: 'Test Angola Customer',
      type: 'CREDIT',
      balances: { usd: 0, kz: 0 },
    });

    // Mixed invoice: 2 x 100 USD = 200 USD, and 3 x 5000 Kz = 15000 Kz
    // Initial payments: 50 USD into USD box + 5000 Kz into Kz box
    const res = await createInvoice({
      customerId: customer._id,
      type: 'CREDIT',
      items: [
        { productId: usdProd._id, quantity: 2 },
        { productId: kzProd._id, quantity: 3 },
      ],
      payments: [
        { cashboxId: usdBox._id, amount: 50, currency: 'USD', notes: 'Partial USD payment' },
        { cashboxId: kzBox._id, amount: 5000, currency: 'Kz', notes: 'Partial Kz payment' },
      ],
      notes: 'Mixed currency invoice test',
    });

    createdInvoice = res.invoice;
    createdPayments = res.payments;

    const updatedUsdProd = await Product.findById(usdProd._id);
    const updatedKzProd = await Product.findById(kzProd._id);
    const updatedUsdBox = await Cashbox.findById(usdBox._id);
    const updatedKzBox = await Cashbox.findById(kzBox._id);
    const updatedCustomer = await Customer.findById(customer._id);

    console.log('Invoice:', createdInvoice.number, '| Type:', createdInvoice.type, '| Status:', createdInvoice.status);
    console.log('Totals:', createdInvoice.totals);
    console.log('Paid:', createdInvoice.paidAmount, '| Remaining:', createdInvoice.remainingAmount);
    console.log('Items created:', res.items.length, '| Payments created:', createdPayments.length);
    console.log('Stock -> USD:', updatedUsdProd.stock.available, '| Kz:', updatedKzProd.stock.available);
    console.log('Cashboxes -> USD:', updatedUsdBox.balance, '| Kz:', updatedKzBox.balance);
    console.log('Customer balances -> USD:', updatedCustomer.balances.usd, '| Kz:', updatedCustomer.balances.kz);
  } finally {
    if (createdInvoice) {
      await Payment.deleteMany({ invoiceId: createdInvoice._id });
      await InvoiceItem.deleteMany({ invoiceId: createdInvoice._id });
      await Invoice.deleteOne({ _id: createdInvoice._id });
      await AuditLog.deleteMany({ entityNumber: createdInvoice.number });
    }
    if (createdPayments.length > 0) {
      await AuditLog.deleteMany({
        entityNumber: { $in: createdPayments.map((p) => p.number) },
      });
    }
    if (usdBox || kzBox) {
      const boxIds = [usdBox?._id, kzBox?._id].filter(Boolean);
      await CashMove.deleteMany({ cashboxId: { $in: boxIds } });
      await Cashbox.deleteMany({ _id: { $in: boxIds } });
    }
    if (usdProd || kzProd) {
      const prodIds = [usdProd?._id, kzProd?._id].filter(Boolean);
      await StockMove.deleteMany({ productId: { $in: prodIds } });
      await Product.deleteMany({ _id: { $in: prodIds } });
    }
    if (customer) {
      await Customer.deleteOne({ _id: customer._id });
    }
    await AuditLog.deleteMany({
      entityNumber: { $in: ['PUR-INV-TEST-USD', 'PUR-INV-TEST-KZ'] },
    });
    await Counter.deleteMany({ key: { $in: ['INVOICE', 'PAYMENT'] } });
    await mongoose.disconnect();
  }
})();