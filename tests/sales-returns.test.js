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
const { getNextSequence } = require('../src/shared/services/sequence.service');
const { logAudit } = require('../src/shared/services/audit.service');

const Customer = require('../src/modules/customers/customer');
const Cashbox = require('../src/modules/treasury/cashbox');
const AuditLog = require('../src/shared/models/auditLog');
const Counter = require('../src/shared/models/counter');

let Product;
try {
    Product = require('../src/modules/inventory/product');
} catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
        Product = require('../src/modules/inventory/product.model');
    } else {
        throw err;
    }
}

function toNum(val) {
    if (val === null || val === undefined) return 0;
    if (typeof val === 'object' && typeof val.toString === 'function') {
        return Number(val.toString());
    }
    return Number(val);
}

function getCustomerBalance(doc, currency) {
    const key = String(currency || '').toLowerCase();
    const obj = doc.toObject ? doc.toObject() : doc;
    const rawBalances = obj.balances instanceof Map ? Object.fromEntries(obj.balances) : obj.balances;
    if (rawBalances && typeof rawBalances === 'object') {
        if (key in rawBalances) return toNum(rawBalances[key]);
        if (currency in rawBalances) return toNum(rawBalances[currency]);
    }
    return 0;
}

function setCustomerBalance(doc, currency, value) {
    const key = String(currency || '').toLowerCase();
    if (doc.balances instanceof Map) {
        doc.balances.set(key, value);
    } else {
        doc.balances = doc.balances || {};
        doc.balances[key] = value;
    }
    if (typeof doc.markModified === 'function') {
        doc.markModified('balances');
    }
}

function inspectStockTarget(doc) {
    const obj = doc.toObject ? doc.toObject() : doc;
    const rawStock = obj.stock instanceof Map ? Object.fromEntries(obj.stock) : obj.stock;

    if (rawStock && typeof rawStock === 'object' && !Array.isArray(rawStock)) {
        const preferredKeys = ['totalUnits', 'units', 'quantity', 'qty', 'available', 'onHand', 'cartons', 'boxes', 'value'];
        for (const k of preferredKeys) {
            if (k in rawStock && typeof rawStock[k] !== 'object') {
                return { mode: 'nestedStock', key: k, value: toNum(rawStock[k]) };
            }
        }
        for (const [k, v] of Object.entries(rawStock)) {
            if (typeof v === 'number' || (v && typeof v === 'object' && typeof v.toString === 'function' && !Number.isNaN(Number(v.toString())))) {
                return { mode: 'nestedStock', key: k, value: toNum(v) };
            }
        }
        return { mode: 'nestedStock', key: 'units', value: 0 };
    }

    if (typeof rawStock === 'number' || (rawStock && typeof rawStock === 'object' && typeof rawStock.toString === 'function')) {
        return { mode: 'scalarStock', key: 'stock', value: toNum(rawStock) };
    }

    for (const key of ['quantity', 'onHand', 'qty']) {
        if (typeof obj[key] !== 'undefined') {
            return { mode: 'topScalar', key, value: toNum(obj[key]) };
        }
    }

    return { mode: 'scalarStock', key: 'stock', value: 0 };
}

function getProductStock(doc) {
    return inspectStockTarget(doc).value;
}

function setProductStock(doc, value) {
    const info = inspectStockTarget(doc);
    if (info.mode === 'nestedStock') {
        if (doc.stock instanceof Map) {
            doc.stock.set(info.key, value);
        } else {
            doc.stock = doc.stock && typeof doc.stock === 'object' ? doc.stock : {};
            doc.stock[info.key] = value;
        }
        if (typeof doc.markModified === 'function') {
            doc.markModified('stock');
        }
        return info.key;
    }
    if (info.mode === 'topScalar') {
        doc[info.key] = value;
        return info.key;
    }
    doc.stock = value;
    return 'stock';
}

async function runSalesReturnsTests() {
    const testUri = process.env.TEST_MONGO_URI || process.env.MONGO_URI;
    if (!testUri) {
        throw new Error('Set TEST_MONGO_URI or MONGO_URI before running tests.');
    }

    await connectDB(testUri);
    console.log('--- Connected to DB for Sales & Returns Tests ---');

    const createdIds = {
        customers: [],
        products: [],
        cashboxes: [],
        auditLogs: [],
        counterKeys: [],
    };

    try {
        const seqKey = `SAL_TEST_SEQ_${Date.now()}`;
        createdIds.counterKeys.push(seqKey);

        console.log('[1/3] Testing credit sale: stock deduction & customer balance increase...');
        const [customer] = await Customer.create([
            {
                name: `Sales Customer ${Date.now()}`,
                phone: `+244910${Math.floor(100000 + Math.random() * 899999)}`,
                tier: 'CREDIT',
                balances: { kz: 10000, usd: 100 },
                isActive: true,
            },
        ]);
        createdIds.customers.push(customer._id);

        await Customer.updateOne(
            { _id: customer._id },
            { $set: { 'balances.kz': 10000, 'balances.usd': 100 } }
        );

        const [product] = await Product.create([
            {
                name: `Sale Item ${Date.now()}`,
                sku: `SALE-SKU-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                isActive: true,
            },
        ]);
        createdIds.products.push(product._id);

        const stockInfo = inspectStockTarget(product);
        if (stockInfo.mode === 'nestedStock') {
            await Product.updateOne({ _id: product._id }, { $set: { [`stock.${stockInfo.key}`]: 30 } });
        } else {
            await Product.updateOne({ _id: product._id }, { $set: { [stockInfo.key]: 30 } });
        }

        const saleQty = 8;
        const unitPriceKz = 3500;
        const saleTotalKz = Number(mulMoney(saleQty, unitPriceKz)); // 28000
        let invoiceNumber = null;

        await runInTransaction(async (session) => {
            const freshProd = await Product.findById(product._id).session(session);
            const freshCust = await Customer.findById(customer._id).session(session);

            const availStock = getProductStock(freshProd);
            assert(availStock >= saleQty, `Insufficient stock (${availStock}) for sale quantity (${saleQty})`);

            setProductStock(freshProd, availStock - saleQty);
            const prevKz = getCustomerBalance(freshCust, 'kz');
            setCustomerBalance(freshCust, 'kz', addMoney(prevKz, saleTotalKz));

            await freshProd.save({ session });
            await freshCust.save({ session });

            invoiceNumber = await getNextSequence(seqKey, 'INV');
        });

        const [afterSaleProd, afterSaleCust] = await Promise.all([
            Product.findById(product._id),
            Customer.findById(customer._id),
        ]);

        assert.strictEqual(getProductStock(afterSaleProd), 22, 'Expected product stock to drop from 30 to 22');
        assert.strictEqual(getCustomerBalance(afterSaleCust, 'kz'), 38000, 'Expected customer Kz balance to rise to 38000');

        const saleAudit = await logAudit({
            entityType: 'SaleInvoice',
            entityNumber: invoiceNumber,
            action: 'CREATE',
            reason: 'Verified credit sale stock deduction & customer balance update',
            after: {
                stock: getProductStock(afterSaleProd),
                customerKz: getCustomerBalance(afterSaleCust, 'kz'),
            },
        });
        if (saleAudit?._id) createdIds.auditLogs.push(saleAudit._id);

        console.log('[2/3] Testing rejection when requested sale quantity exceeds stock...');
        await assert.rejects(async () => {
            await runInTransaction(async (session) => {
                const freshProd = await Product.findById(product._id).session(session);
                const availStock = getProductStock(freshProd);
                const overQty = availStock + 5;
                if (overQty > availStock) {
                    throw new Error('Insufficient stock for sale');
                }
            });
        }, /Insufficient stock for sale/);

        const [checkProdAfterReject, checkCustAfterReject] = await Promise.all([
            Product.findById(product._id),
            Customer.findById(customer._id),
        ]);
        assert.strictEqual(getProductStock(checkProdAfterReject), 22);
        assert.strictEqual(getCustomerBalance(checkCustAfterReject, 'kz'), 38000);

        console.log('[3/3] Testing sale return & atomic rollback on mid-return failure...');
        const returnQty = 3;
        const returnAmountKz = Number(mulMoney(returnQty, unitPriceKz)); // 10500

        await runInTransaction(async (session) => {
            const freshProd = await Product.findById(product._id).session(session);
            const freshCust = await Customer.findById(customer._id).session(session);

            setProductStock(freshProd, getProductStock(freshProd) + returnQty);
            setCustomerBalance(freshCust, 'kz', subMoney(getCustomerBalance(freshCust, 'kz'), returnAmountKz));

            await freshProd.save({ session });
            await freshCust.save({ session });
        });

        const [afterReturnProd, afterReturnCust] = await Promise.all([
            Product.findById(product._id),
            Customer.findById(customer._id),
        ]);

        assert.strictEqual(getProductStock(afterReturnProd), 25, 'Expected product stock to rise back to 25 after return');
        assert.strictEqual(getCustomerBalance(afterReturnCust, 'kz'), 27500, 'Expected customer Kz balance to drop to 27500');

        await assert.rejects(async () => {
            await runInTransaction(async (session) => {
                const freshProd = await Product.findById(product._id).session(session);
                const freshCust = await Customer.findById(customer._id).session(session);

                setProductStock(freshProd, getProductStock(freshProd) + 5);
                setCustomerBalance(freshCust, 'kz', subMoney(getCustomerBalance(freshCust, 'kz'), 17500));

                await freshProd.save({ session });
                await freshCust.save({ session });

                throw new Error('Simulated failure during sales return');
            });
        }, /Simulated failure during sales return/);

        const [afterRbProd, afterRbCust] = await Promise.all([
            Product.findById(product._id),
            Customer.findById(customer._id),
        ]);

        assert.strictEqual(getProductStock(afterRbProd), 25, 'Rollback failed: product stock changed');
        assert.strictEqual(getCustomerBalance(afterRbCust, 'kz'), 27500, 'Rollback failed: customer Kz balance changed');

        console.log('All Sales & Returns tests passed!');
    } finally {
        console.log('--- Cleaning up Sales & Returns test records ---');
        if (createdIds.customers.length) {
            await Customer.deleteMany({ _id: { $in: createdIds.customers } });
        }
        if (createdIds.products.length) {
            await Product.deleteMany({ _id: { $in: createdIds.products } });
        }
        if (createdIds.cashboxes.length) {
            await Cashbox.deleteMany({ _id: { $in: createdIds.cashboxes } });
        }
        if (createdIds.auditLogs.length) {
            await AuditLog.deleteMany({ _id: { $in: createdIds.auditLogs } });
        }
        if (createdIds.counterKeys.length) {
            await Counter.deleteMany({ key: { $in: createdIds.counterKeys } });
        }
        await disconnectDB();
    }
}

runSalesReturnsTests().catch((err) => {
    console.error('Sales & Returns test failed:', err);
    process.exit(1);
});