require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/config/db');
const Customer = require('./src/modules/customers');
const Product = require('./src/modules/inventory/product');
const StockMove = require('./src/modules/inventory/stockMove');
const Cashbox = require('./src/modules/treasury/cashbox');
const CashMove = require('./src/modules/treasury/cashMove');
const ReturnInvoice = require('./src/modules/returns/returnInvoice');
const AuditLog = require('./src/shared/models/auditLog');
const Counter = require('./src/shared/models/counter');
const { createReturnInvoice } = require('./src/modules/returns/returns.service');

(async () => {
    let usdProduct = null;
    let kzProduct = null;
    let usdBox = null;
    let customer = null;
    const createdReturns = [];

    try {
        await connectDB(process.env.MONGO_URI);

        [usdProduct, kzProduct] = await Product.create([
            {
                sku: 'RET-SKU-USD',
                name: 'Test Return USD Item',
                currency: 'USD',
                cost: 80,
                stock: { available: 5, damaged: 0 },
                prices: { cash: 100, credit: 110, wholesale: 90 },
            },
            {
                sku: 'RET-SKU-KZ',
                name: 'Test Return Kz Item',
                currency: 'Kz',
                cost: 40000,
                stock: { available: 10, damaged: 0 },
                prices: { cash: 50000, credit: 55000, wholesale: 45000 },
            },
        ]);

        usdBox = await Cashbox.create({
            name: 'Test Return USD Box',
            currency: 'USD',
            balance: 500,
        });

        customer = await Customer.create({
            name: 'Test Return Customer',
            type: 'CREDIT',
            balances: { usd: 150, kz: 100000 },
            creditBalances: { usd: 0, kz: 0 },
        });

        // Case 1: Customer return (standalone, no original invoice)
        // - 1 unit USD product -> AVAILABLE (credits 100 USD to customer USD balance -> 50)
        // - 1 unit Kz product -> DAMAGED (credits 50,000 Kz to customer Kz balance -> 50,000)
        const ret1 = await createReturnInvoice({
            customerId: customer._id,
            priceList: 'CASH',
            reason: 'Customer return test (AVAILABLE + DAMAGED)',
            items: [
                { productId: usdProduct._id, quantity: 1, stockBucket: 'AVAILABLE' },
                { productId: kzProduct._id, quantity: 1, stockBucket: 'DAMAGED' },
            ],
        });
        createdReturns.push(ret1.returnInvoice.number);

        const pUsdAfter1 = await Product.findById(usdProduct._id);
        const pKzAfter1 = await Product.findById(kzProduct._id);

        console.log('After RET-1 (Customer credit return):');
        console.log('  Number:', ret1.returnInvoice.number, '| Totals:', ret1.returnInvoice.totals);
        console.log('  Credited:', ret1.returnInvoice.creditedAmount);
        console.log('  Customer balances:', ret1.customer.balances, '| creditBalances:', ret1.customer.creditBalances);
        console.log('  USD Product stock -> available:', pUsdAfter1.stock.available, '| damaged:', pUsdAfter1.stock.damaged);
        console.log('  Kz Product stock  -> available:', pKzAfter1.stock.available, '| damaged:', pKzAfter1.stock.damaged);

        // Case 2: Walk-in return with direct cash refund from USD cashbox
        const ret2 = await createReturnInvoice({
            customerId: null,
            priceList: 'CASH',
            reason: 'Walk-in cash refund return test',
            items: [{ productId: usdProduct._id, quantity: 1, stockBucket: 'AVAILABLE' }],
            refunds: [{ cashboxId: usdBox._id, amount: 100, currency: 'USD', notes: 'Cash refund' }],
        });
        createdReturns.push(ret2.returnInvoice.number);

        const boxAfter2 = await Cashbox.findById(usdBox._id);
        const pUsdAfter2 = await Product.findById(usdProduct._id);

        console.log('After RET-2 (Walk-in cash refund):');
        console.log('  Number:', ret2.returnInvoice.number, '| Refunded:', ret2.returnInvoice.refundedAmount);
        console.log('  USD cashbox balance:', boxAfter2.balance, '| USD available stock:', pUsdAfter2.stock.available);
    } finally {
        if (createdReturns.length > 0) {
            await ReturnInvoice.deleteMany({ number: { $in: createdReturns } });
            await AuditLog.deleteMany({ entityNumber: { $in: createdReturns } });
            const prodIds = [usdProduct?._id, kzProduct?._id].filter(Boolean);
            if (prodIds.length > 0) {
                await StockMove.deleteMany({ productId: { $in: prodIds } });
            }
        }
        if (usdBox) {
            await CashMove.deleteMany({ cashboxId: usdBox._id });
            await Cashbox.deleteOne({ _id: usdBox._id });
        }
        if ([usdProduct?._id, kzProduct?._id].filter(Boolean).length > 0) {
            await Product.deleteMany({ _id: { $in: [usdProduct?._id, kzProduct?._id].filter(Boolean) } });
        }
        if (customer) {
            await Customer.deleteOne({ _id: customer._id });
        }
        await Counter.deleteMany({ key: 'RETURN' });
        await mongoose.disconnect();
    }
})();