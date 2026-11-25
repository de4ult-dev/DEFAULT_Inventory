const mongoose = require('mongoose');

const purchaseItemSchema = new mongoose.Schema(
    {
        productId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Product',
            required: true,
        },
        skuSnapshot: { type: String, trim: true, default: '' },
        nameSnapshot: { type: String, trim: true, default: '' },
        quantity: { type: Number, required: true, min: 0 },
        receivedQuantity: { type: Number, default: 0, min: 0 },
        unitCost: { type: Number, required: true, min: 0 },
        currency: { type: String, enum: ['USD', 'Kz'], required: true },
        lineTotal: { type: Number, required: true, min: 0 },
        landedUnitCost: { type: Number, default: 0, min: 0 },
        landedCurrency: { type: String, enum: ['USD', 'Kz'], default: 'Kz' },
    },
    { _id: false }
);

const purchaseOrderSchema = new mongoose.Schema(
    {
        number: {
            type: String,
            required: [true, 'Reference number is required'],
            unique: true,
            trim: true,
        },
        // PO = Container order (USD), CNT = Container receipt, LP = Local purchase (Kz)
        type: {
            type: String,
            enum: ['CONTAINER_ORDER', 'CONTAINER_RECEIPT', 'LOCAL_PURCHASE'],
            required: true,
        },
        parentOrderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'PurchaseOrder',
            default: null,
        },
        supplierId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Supplier',
            required: [true, 'Supplier is required'],
            index: true,
        },
        supplierNameSnapshot: {
            type: String,
            trim: true,
            default: '',
        },
        currency: {
            type: String,
            enum: ['USD', 'Kz'],
            required: true,
        },
        status: {
            type: String,
            enum: ['DRAFT', 'AWAITING_RECEIPT', 'PARTIAL', 'RECEIVED', 'CANCELLED'],
            required: true,
        },
        items: {
            type: [purchaseItemSchema],
            default: [],
        },
        goodsAmount: {
            type: Number,
            required: true,
            default: 0,
            min: 0,
        },
        // Extra arrival costs (customs, transport, etc.)
        additionalCosts: {
            customs: { type: Number, default: 0, min: 0 },
            transport: { type: Number, default: 0, min: 0 },
            other: { type: Number, default: 0, min: 0 },
            currency: { type: String, enum: ['USD', 'Kz'], default: 'Kz' },
            cashboxId: { type: mongoose.Schema.Types.ObjectId, ref: 'Cashbox', default: null },
            exchangeRate: { type: Number, default: 1, min: 0 },
        },
        totalAmount: {
            type: Number,
            required: true,
            default: 0,
            min: 0,
        },
        date: {
            type: Date,
            required: true,
            default: Date.now,
        },
        notes: {
            type: String,
            trim: true,
            default: '',
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
    },
    { timestamps: true }
);

purchaseOrderSchema.index({ type: 1, status: 1, date: -1 });
purchaseOrderSchema.index({ supplierId: 1, date: -1 });
purchaseOrderSchema.index({ parentOrderId: 1 });

module.exports = mongoose.model('PurchaseOrder', purchaseOrderSchema);