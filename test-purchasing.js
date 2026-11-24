require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/config/db');
const Supplier = require('./src/modules/suppliers');
const Product = require('./src/modules/inventory/product');
const StockMove = require('./src/modules/inventory/stockMove');
const Cashbox = require('./src/modules/treasury/cashbox');
const CashMove = require('./src/modules/treasury/cashMove');
const PurchaseOrder = require('./src/modules/purchasing/purchaseOrder');
const AuditLog = require('./src/shared/models/auditLog');
const Counter = require('./src/shared/models/counter');
const {
    createContainerOrder,
    receiveContainer,
    createLocalPurchase,
} = require('./src/modules/purchasing/purchasing.service');

(async () => {
    let extSupplier = null;
    let locSupplier = null;
    let usdProduct = null;
    let kzProduct = null;
    let kzBox = null;
    const createdNumbers = [];

    try {
        await connectDB(process.env.MONGO_URI);

        [extSupplier, locSupplier] = await Supplier.create([
            { name: 'Test External Supplier USD', type: 'EXTERNAL', defaultCurrency: 'USD' },
            { name: 'Test Local Supplier Kz', type: 'LOCAL', defaultCurrency: 'Kz' },
        ]);

        [usdProduct, kzProduct] = await Product.create([
            {
                sku: 'PO-SKU-USD',
                name: 'Container USD Product',
                currency: 'USD',
                cost: 50,
                stock: { available: 10, damaged: 0 },
                prices: { cash: 80, credit: 85, wholesale: 75 },
            },
            {
                sku: 'LP-SKU-KZ',
                name: 'Local Kz Product',
                currency: 'Kz',
                cost: 20000,
                stock: { available: 5, damaged: 0 },
                prices: { cash: 30000, credit: 32000, wholesale: 28000 },
            },
        ]);

        kzBox = await Cashbox.create({
            name: 'Test Purchasing Kz Box',
            currency: 'Kz',
            balance: 5000000,
        });

        // 1. Container Order (PO) in USD
        const poRes = await createContainerOrder({
            supplierId: extSupplier._id,
            items: [{ productId: usdProduct._id, quantity: 10, unitCost: 50 }],
            notes: 'Test container order PO',
        });
        createdNumbers.push(poRes.order.number);

        const pAfterPo = await Product.findById(usdProduct._id);
        console.log('1) After PO:', poRes.order.number, '| Status:', poRes.order.status);
        console.log('   Supplier USD balance:', poRes.supplier.balances.usd, '| Product stock.available:', pAfterPo.stock.available);

        // 2. Container Receipt (CNT) with Kz arrival costs converted @ 1,000 Kz/USD (200,000 Kz = 200 USD -> +20 USD/unit -> landed 70 USD/unit)
        const cntRes = await receiveContainer({
            purchaseOrderId: poRes.order._id,
            additionalCosts: {
                customs: 150000,
                transport: 50000,
                currency: 'Kz',
                cashboxId: kzBox._id,
                exchangeRate: 1000,
            },
            notes: 'Test container receipt CNT',
        });
        createdNumbers.push(cntRes.receipt.number);

        const pAfterCnt = await Product.findById(usdProduct._id);
        const boxAfterCnt = await Cashbox.findById(kzBox._id);
        console.log('2) After CNT:', cntRes.receipt.number, '| PO Status:', cntRes.order.status);
        console.log('   Landed unit cost:', cntRes.receipt.items[0].landedUnitCost, '| Product cost:', pAfterCnt.cost);
        console.log('   Product stock.available:', pAfterCnt.stock.available, '| Kz cashbox:', boxAfterCnt.balance);

        // 3. Local Purchase (LP): Draft then Received
        const lpDraft = await createLocalPurchase({
            supplierId: locSupplier._id,
            items: [{ productId: kzProduct._id, quantity: 2, unitCost: 20000 }],
            status: 'DRAFT',
            notes: 'Test draft LP',
        });
        createdNumbers.push(lpDraft.purchase.number);

        const lpReceived = await createLocalPurchase({
            supplierId: locSupplier._id,
            items: [{ productId: kzProduct._id, quantity: 5, unitCost: 22000 }],
            status: 'RECEIVED',
            notes: 'Test received LP',
        });
        createdNumbers.push(lpReceived.purchase.number);

        const pKzAfterLp = await Product.findById(kzProduct._id);
        console.log('3) After LP Draft:', lpDraft.purchase.number, '& LP Received:', lpReceived.purchase.number);
        console.log('   Supplier Kz balance:', lpReceived.supplier.balances.kz, '| Kz stock.available:', pKzAfterLp.stock.available);
    } finally {
        if (createdNumbers.length > 0) {
            await PurchaseOrder.deleteMany({ number: { $in: createdNumbers } });
            await AuditLog.deleteMany({ entityNumber: { $in: createdNumbers } });
        }
        const prodIds = [usdProduct?._id, kzProduct?._id].filter(Boolean);
        if (prodIds.length > 0) {
            await StockMove.deleteMany({ productId: { $in: prodIds } });
            await Product.deleteMany({ _id: { $in: prodIds } });
        }
        if (kzBox) {
            await CashMove.deleteMany({ cashboxId: kzBox._id });
            await Cashbox.deleteOne({ _id: kzBox._id });
        }
        const supIds = [extSupplier?._id, locSupplier?._id].filter(Boolean);
        if (supIds.length > 0) {
            await Supplier.deleteMany({ _id: { $in: supIds } });
        }
        await Counter.deleteMany({ key: { $in: ['CONTAINER_ORDER', 'CONTAINER_RECEIPT', 'LOCAL_PURCHASE'] } });
        await mongoose.disconnect();
    }
})();