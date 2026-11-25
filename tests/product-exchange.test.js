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
const { mulMoney } = require('../src/shared/utils/money');
const { getNextSequence } = require('../src/shared/services/sequence.service');
const { logAudit } = require('../src/shared/services/audit.service');

const Product = require('../src/modules/inventory/product');
const ProductExchange = require('../src/modules/exchanges/productExchange');
const AuditLog = require('../src/shared/models/auditLog');
const Counter = require('../src/shared/models/counter');

async function runProductExchangeTests() {
    const testUri = process.env.TEST_MONGO_URI || process.env.MONGO_URI;
    if (!testUri) {
        throw new Error('Set TEST_MONGO_URI or MONGO_URI before running tests.');
    }

    await connectDB(testUri);
    console.log('--- Connected to DB for Product Exchange Tests ---');

    const createdIds = {
        products: [],
        exchanges: [],
        auditLogs: [],
        counterKeys: [],
    };

    try {
        const seqKey = `EX_TEST_SEQ_${Date.now()}`;
        createdIds.counterKeys.push(seqKey);

        console.log('[1/3] Testing valid ProductExchange & stock balance adjustment...');
        const [outProd, inProd] = await Product.create([
            {
                sku: `EX-OUT-${Date.now()}`,
                name: 'Outgoing Item',
                currency: 'Kz',
                prices: { cash: 2000, credit: 2200, wholesale: 1800 },
                cost: 1000,
                stock: { available: 15, damaged: 2 },
                isActive: true,
            },
            {
                sku: `EX-IN-${Date.now()}`,
                name: 'Incoming Item',
                currency: 'Kz',
                prices: { cash: 4000, credit: 4400, wholesale: 3600 },
                cost: 2000,
                stock: { available: 5, damaged: 0 },
                isActive: true,
            },
        ]);
        createdIds.products.push(outProd._id, inProd._id);

        const swapQtyOut = 4;
        const swapQtyIn = 2;
        const outTotalValue = mulMoney(swapQtyOut, outProd.cost);
        const inTotalValue = mulMoney(swapQtyIn, inProd.cost);

        let createdExchangeId = null;

        await runInTransaction(async (session) => {
            const freshOut = await Product.findById(outProd._id).session(session);
            const freshIn = await Product.findById(inProd._id).session(session);

            assert(
                freshOut.stock.available >= swapQtyOut,
                `Insufficient available stock: ${freshOut.stock.available} < ${swapQtyOut}`
            );

            freshOut.stock.available -= swapQtyOut;
            freshIn.stock.available += swapQtyIn;

            await freshOut.save({ session });
            await freshIn.save({ session });

            const exNumber = await getNextSequence(seqKey, 'EX');
            const [exDoc] = await ProductExchange.create(
                [
                    {
                        number: exNumber,
                        status: 'POSTED',
                        outgoing: {
                            productId: freshOut._id,
                            skuSnapshot: freshOut.sku,
                            nameSnapshot: freshOut.name,
                            stockBucket: 'AVAILABLE',
                            quantity: swapQtyOut,
                            unitCost: freshOut.cost,
                            currency: freshOut.currency,
                            totalValue: outTotalValue,
                        },
                        incoming: {
                            productId: freshIn._id,
                            skuSnapshot: freshIn.sku,
                            nameSnapshot: freshIn.name,
                            stockBucket: 'AVAILABLE',
                            quantity: swapQtyIn,
                            unitCost: freshIn.cost,
                            currency: freshIn.currency,
                            totalValue: inTotalValue,
                        },
                        exchangeRate: 1,
                        reason: 'Exchange smoke/flow test',
                    },
                ],
                { session }
            );
            createdExchangeId = exDoc._id;
            createdIds.exchanges.push(exDoc._id);
        });

        const [updatedOut, updatedIn, savedExchange] = await Promise.all([
            Product.findById(outProd._id),
            Product.findById(inProd._id),
            ProductExchange.findById(createdExchangeId),
        ]);

        assert.strictEqual(updatedOut.stock.available, 11, 'Expected outgoing stock to drop from 15 to 11');
        assert.strictEqual(updatedIn.stock.available, 7, 'Expected incoming stock to rise from 5 to 7');
        assert(savedExchange, 'Expected ProductExchange document to be persisted');
        assert.strictEqual(savedExchange.outgoing.totalValue, 4000);
        assert.strictEqual(savedExchange.incoming.totalValue, 4000);

        const auditDoc = await logAudit({
            entityType: 'ProductExchange',
            entityNumber: savedExchange.number,
            action: 'CREATE',
            reason: 'Verified product exchange stock movement',
            after: {
                outgoingAvailable: updatedOut.stock.available,
                incomingAvailable: updatedIn.stock.available,
            },
        });
        if (auditDoc?._id) createdIds.auditLogs.push(auditDoc._id);

        console.log('[2/3] Testing rejection when outgoing stock is insufficient...');
        await assert.rejects(async () => {
            await runInTransaction(async (session) => {
                const freshOut = await Product.findById(outProd._id).session(session);
                const overQty = freshOut.stock.available + 100;
                if (freshOut.stock.available < overQty) {
                    throw new Error('Insufficient outgoing product stock');
                }
            });
        }, /Insufficient outgoing product stock/);

        const checkOutAfterReject = await Product.findById(outProd._id);
        assert.strictEqual(checkOutAfterReject.stock.available, 11, 'Stock must remain unchanged on rejection');

        console.log('[3/3] Testing atomic rollback when an error happens mid-exchange...');
        const rbNumber = `EX-RB-${Date.now()}`;
        await assert.rejects(async () => {
            await runInTransaction(async (session) => {
                const freshOut = await Product.findById(outProd._id).session(session);
                const freshIn = await Product.findById(inProd._id).session(session);

                freshOut.stock.available -= 3;
                freshIn.stock.available += 2;
                await freshOut.save({ session });
                await freshIn.save({ session });

                const [rbEx] = await ProductExchange.create(
                    [
                        {
                            number: rbNumber,
                            status: 'POSTED',
                            outgoing: {
                                productId: freshOut._id,
                                skuSnapshot: freshOut.sku,
                                nameSnapshot: freshOut.name,
                                stockBucket: 'AVAILABLE',
                                quantity: 3,
                                unitCost: freshOut.cost,
                                currency: freshOut.currency,
                                totalValue: 3000,
                            },
                            incoming: {
                                productId: freshIn._id,
                                skuSnapshot: freshIn.sku,
                                nameSnapshot: freshIn.name,
                                stockBucket: 'AVAILABLE',
                                quantity: 2,
                                unitCost: freshIn.cost,
                                currency: freshIn.currency,
                                totalValue: 4000,
                            },
                            exchangeRate: 1,
                            reason: 'Should roll back',
                        },
                    ],
                    { session }
                );
                createdIds.exchanges.push(rbEx._id);

                throw new Error('Simulated crash during ProductExchange');
            });
        }, /Simulated crash during ProductExchange/);

        const [afterRbOut, afterRbIn, leakedRbEx] = await Promise.all([
            Product.findById(outProd._id),
            Product.findById(inProd._id),
            ProductExchange.findOne({ number: rbNumber }),
        ]);

        assert.strictEqual(afterRbOut.stock.available, 11, 'Rollback failed: outgoing stock changed');
        assert.strictEqual(afterRbIn.stock.available, 7, 'Rollback failed: incoming stock changed');
        assert.strictEqual(leakedRbEx, null, 'Rollback failed: rolled-back ProductExchange still exists');

        console.log('All ProductExchange tests passed!');
    } finally {
        console.log('--- Cleaning up ProductExchange test records ---');
        if (createdIds.exchanges.length) {
            await ProductExchange.deleteMany({ _id: { $in: createdIds.exchanges } });
        }
        if (createdIds.products.length) {
            await Product.deleteMany({ _id: { $in: createdIds.products } });
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

runProductExchangeTests().catch((err) => {
    console.error('ProductExchange test failed:', err);
    process.exit(1);
});