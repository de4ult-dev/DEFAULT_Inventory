require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/config/db');
const Customer = require('./src/modules/customers');
const Product = require('./src/modules/inventory/product');
const StockMove = require('./src/modules/inventory/stockMove');
const ProductExchange = require('./src/modules/exchanges/productExchange');
const AuditLog = require('./src/shared/models/auditLog');
const Counter = require('./src/shared/models/counter');
const { createProductExchange } = require('./src/modules/exchanges/exchanges.service');

(async () => {
    let prodA = null;
    let prodB = null;
    let customer = null;
    const createdExchanges = [];

    try {
        await connectDB(process.env.MONGO_URI);

        [prodA, prodB] = await Product.create([
            {
                sku: 'EX-SKU-A',
                name: 'Exchange Item A (USD)',
                currency: 'USD',
                cost: 25,
                stock: { available: 10, damaged: 0 },
                prices: { cash: 35, credit: 40, wholesale: 30 },
            },
            {
                sku: 'EX-SKU-B',
                name: 'Exchange Item B (Kz)',
                currency: 'Kz',
                cost: 50000,
                stock: { available: 4, damaged: 0 },
                prices: { cash: 65000, credit: 70000, wholesale: 60000 },
            },
        ]);

        customer = await Customer.create({
            name: 'Test Exchange Customer',
            type: 'CREDIT',
            balances: { usd: 300, kz: 150000 },
            creditBalances: { usd: 0, kz: 0 },
        });

        // Exchange 2 units of prodA (2 * 25 = 50 USD -> @ 1,000 = 50,000 Kz) for 1 unit of prodB (50,000 Kz)
        const res = await createProductExchange({
            customerId: customer._id,
            outgoing: { productId: prodA._id, quantity: 2 },
            incoming: { productId: prodB._id, quantity: 1 },
            exchangeRate: 1000,
            reason: 'Value-neutral exchange test',
        });
        createdExchanges.push(res.exchange.number);

        const custAfter = await Customer.findById(customer._id);
        console.log('Exchange:', res.exchange.number);
        console.log('  Outgoing:', res.exchange.outgoing);
        console.log('  Incoming:', res.exchange.incoming);
        console.log('  ProdA available:', res.outgoingProduct.stock.available, '| ProdB available:', res.incomingProduct.stock.available);
        console.log('  ProdB moving avg cost:', res.incomingProduct.cost);
        console.log('  Customer balances (unchanged):', custAfter.balances);
    } finally {
        if (createdExchanges.length > 0) {
            await ProductExchange.deleteMany({ number: { $in: createdExchanges } });
            await AuditLog.deleteMany({ entityNumber: { $in: createdExchanges } });
        }
        const prodIds = [prodA?._id, prodB?._id].filter(Boolean);
        if (prodIds.length > 0) {
            await StockMove.deleteMany({ productId: { $in: prodIds } });
            await Product.deleteMany({ _id: { $in: prodIds } });
        }
        if (customer) {
            await Customer.deleteOne({ _id: customer._id });
        }
        await Counter.deleteMany({ key: 'PRODUCT_EXCHANGE' });
        await mongoose.disconnect();
    }
})();