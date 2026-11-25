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
const { getNextSequence } = require('../src/shared/services/sequence.service');
const { logAudit } = require('../src/shared/services/audit.service');

const Supplier = require('../src/modules/suppliers/supplier');
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

function getSupplierBalance(doc, currency) {
    const key = String(currency || '').toLowerCase();
    const obj = doc.toObject ? doc.toObject() : doc;
    const rawBalances = obj.balances instanceof Map ? Object.fromEntries(obj.balances) : obj.balances;
    if (rawBalances && typeof rawBalances === 'object') {
        if (key in rawBalances) return toNum(rawBalances[key]);
        if (currency in rawBalances) return toNum(rawBalances[currency]);
    }
    return 0;
}

function setSupplierBalance(doc, currency, value) {
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
        return { mode: 'nestedStock', key: 'units', value: 0, rawStock };
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

async function runPurchasingTests() {
    const testUri = process.env.TEST_MONGO_URI || process.env.MONGO_URI;
    if (!testUri) {
        throw new Error('Set TEST_MONGO_URI or MONGO_URI before running tests.');
    }

    await connectDB(testUri);
    console.log('--- Connected to DB for Purchasing & Landed Cost Tests ---');

    const createdIds = {
        suppliers: [],
        products: [],
        cashboxes: [],
        auditLogs: [],
        counterKeys: [],
    };

    try {
        const seqKey = `PUR_TEST_SEQ_${Date.now()}`;
        createdIds.counterKeys.push(seqKey);

        console.log('[1/3] Testing local purchasing (Kz): stock increase & supplier liability...');
        const [localSupplier] = await Supplier.create([
            {
                name: `Local PO Supplier ${Date.now()}`,
                type: 'LOCAL',
                defaultCurrency: 'Kz',
                balances: { kz: 0, usd: 0 },
                isActive: true,
            },
        ]);
        createdIds.suppliers.push(localSupplier._id);

        const [product] = await Product.create([
            {
                name: `ERP Item ${Date.now()}`,
                sku: `SKU-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                isActive: true,
            },
        ]);
        createdIds.products.push(product._id);

        const initInfo = inspectStockTarget(product);
        if (initInfo.mode === 'nestedStock') {
            await Product.updateOne({ _id: product._id }, { $set: { [`stock.${initInfo.key}`]: 10 } });
        } else {
            await Product.updateOne({ _id: product._id }, { $set: { [initInfo.key]: 10 } });
        }

        const localQty = 15;
        const unitCostKz = 2000;
        const totalLocalKz = Number(mulMoney(localQty, unitCostKz));
        let localPoNumber = null;

        await runInTransaction(async (session) => {
            const freshSupplier = await Supplier.findById(localSupplier._id).session(session);
            const freshProduct = await Product.findById(product._id).session(session);

            const currentStock = getProductStock(freshProduct);
            setProductStock(freshProduct, currentStock + localQty);

            const currentKzDebt = getSupplierBalance(freshSupplier, 'kz');
            setSupplierBalance(freshSupplier, 'kz', addMoney(currentKzDebt, totalLocalKz));

            await freshProduct.save({ session });
            await freshSupplier.save({ session });

            localPoNumber = await getNextSequence(seqKey, 'LPO');
        });

        const [afterLocalSupp, afterLocalProd] = await Promise.all([
            Supplier.findById(localSupplier._id),
            Product.findById(product._id),
        ]);

        assert.strictEqual(getProductStock(afterLocalProd), 25, 'Expected product stock to rise from 10 to 25');
        assert.strictEqual(getSupplierBalance(afterLocalSupp, 'kz'), 30000, 'Expected local supplier Kz liability to be 30000');

        const localAudit = await logAudit({
            entityType: 'LocalPurchase',
            entityNumber: localPoNumber,
            action: 'CREATE',
            reason: 'Verified local Kz purchase goods receipt & supplier liability',
            after: {
                stock: getProductStock(afterLocalProd),
                supplierKz: getSupplierBalance(afterLocalSupp, 'kz'),
            },
        });
        if (localAudit?._id) createdIds.auditLogs.push(localAudit._id);

        console.log('[2/3] Testing external container (USD): landed cost allocation, stock & cashbox...');
        const [extSupplier] = await Supplier.create([
            {
                name: `External USD Supplier ${Date.now()}`,
                type: 'EXTERNAL',
                defaultCurrency: 'USD',
                balances: { kz: 0, usd: 0 },
                isActive: true,
            },
        ]);
        createdIds.suppliers.push(extSupplier._id);

        const [usdBox] = await Cashbox.create([
            {
                name: `Customs & Freight USD Box ${Date.now()}`,
                currency: 'USD',
                balance: 5000,
                isActive: true,
            },
        ]);
        createdIds.cashboxes.push(usdBox._id);

        const containerQty = 20;
        const factoryUnitUsd = 40;
        const freightUsd = 200;
        const customsAndInlandUsd = 100;
        const supplierLiabilityUsd = addMoney(mulMoney(containerQty, factoryUnitUsd), freightUsd);
        const totalLandedUsd = addMoney(supplierLiabilityUsd, customsAndInlandUsd);
        const expectedUnitLandedCost = Number((totalLandedUsd / containerQty).toFixed(2));

        assert.strictEqual(supplierLiabilityUsd, 1000);
        assert.strictEqual(expectedUnitLandedCost, 55);

        await runInTransaction(async (session) => {
            const freshExtSupp = await Supplier.findById(extSupplier._id).session(session);
            const freshProd = await Product.findById(product._id).session(session);
            const freshUsdBox = await Cashbox.findById(usdBox._id).session(session);

            assertSufficientCash(freshUsdBox.balance, customsAndInlandUsd, freshUsdBox.name, freshUsdBox.currency);

            const currentUsdDebt = getSupplierBalance(freshExtSupp, 'usd');
            setSupplierBalance(freshExtSupp, 'usd', addMoney(currentUsdDebt, supplierLiabilityUsd));

            const currentStock = getProductStock(freshProd);
            setProductStock(freshProd, currentStock + containerQty);
            if (typeof freshProd.landedCost !== 'undefined' || 'landedCost' in freshProd) {
                freshProd.landedCost = expectedUnitLandedCost;
            }
            if (typeof freshProd.costPrice !== 'undefined' || 'costPrice' in freshProd) {
                freshProd.costPrice = expectedUnitLandedCost;
            }

            freshUsdBox.balance = subMoney(toNum(freshUsdBox.balance), customsAndInlandUsd);

            await freshExtSupp.save({ session });
            await freshProd.save({ session });
            await freshUsdBox.save({ session });
        });

        const [afterExtSupp, afterContProd, afterUsdBox] = await Promise.all([
            Supplier.findById(extSupplier._id),
            Product.findById(product._id),
            Cashbox.findById(usdBox._id),
        ]);

        assert.strictEqual(getSupplierBalance(afterExtSupp, 'usd'), 1000, 'Expected external supplier USD balance to be 1000');
        assert.strictEqual(getProductStock(afterContProd), 45, 'Expected product stock to rise from 25 to 45');
        assert.strictEqual(toNum(afterUsdBox.balance), 4900, 'Expected USD cashbox to drop from 5000 to 4900');

        console.log('[3/3] Testing atomic rollback when container receipt fails mid-way...');
        await assert.rejects(async () => {
            await runInTransaction(async (session) => {
                const freshExtSupp = await Supplier.findById(extSupplier._id).session(session);
                const freshProd = await Product.findById(product._id).session(session);
                const freshUsdBox = await Cashbox.findById(usdBox._id).session(session);

                setSupplierBalance(freshExtSupp, 'usd', addMoney(getSupplierBalance(freshExtSupp, 'usd'), 500));
                setProductStock(freshProd, getProductStock(freshProd) + 10);
                freshUsdBox.balance = subMoney(toNum(freshUsdBox.balance), 50);

                await freshExtSupp.save({ session });
                await freshProd.save({ session });
                await freshUsdBox.save({ session });

                throw new Error('Simulated failure during container landed cost posting');
            });
        }, /Simulated failure during container landed cost posting/);

        const [afterRbSupp, afterRbProd, afterRbBox] = await Promise.all([
            Supplier.findById(extSupplier._id),
            Product.findById(product._id),
            Cashbox.findById(usdBox._id),
        ]);

        assert.strictEqual(getSupplierBalance(afterRbSupp, 'usd'), 1000, 'Rollback failed: external supplier USD changed');
        assert.strictEqual(getProductStock(afterRbProd), 45, 'Rollback failed: product stock changed');
        assert.strictEqual(toNum(afterRbBox.balance), 4900, 'Rollback failed: USD cashbox changed');

        console.log('All Purchasing & Landed Cost tests passed!');
    } finally {
        console.log('--- Cleaning up Purchasing test records ---');
        if (createdIds.suppliers.length) {
            await Supplier.deleteMany({ _id: { $in: createdIds.suppliers } });
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

runPurchasingTests().catch((err) => {
    console.error('Purchasing test failed:', err);
    process.exit(1);
});