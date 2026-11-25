const mongoose = require('mongoose');

const invoiceItemSchema = new mongoose.Schema(
    {
        invoiceId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Invoice',
            required: [true, 'Invoice reference is required'],
            index: true,
        },
        productId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Product',
            required: [true, 'Product reference is required'],
        },
        skuSnapshot: {
            type: String,
            trim: true,
            default: '',
        },
        nameSnapshot: {
            type: String,
            trim: true,
            default: '',
        },
        quantity: {
            type: Number,
            required: [true, 'Quantity is required'],
            min: [0.000001, 'Quantity must be greater than zero'],
        },
        unitPrice: {
            type: Number,
            required: [true, 'Unit price is required'],
            min: [0, 'Unit price cannot be negative'],
        },
        priceSource: {
            type: String,
            enum: ['PRICE_LIST', 'MANUAL_OVERRIDE'],
            default: 'PRICE_LIST',
        },
        currency: {
            type: String,
            enum: ['USD', 'Kz'],
            required: [true, 'Item currency is required'],
        },
        lineTotal: {
            type: Number,
            required: true,
            default: 0,
            min: [0, 'Line total cannot be negative'],
        },
        unitCostSnapshot: {
            type: Number,
            default: 0,
            min: [0, 'Unit cost snapshot cannot be negative'],
        },
    },
    { timestamps: true }
);

invoiceItemSchema.index({ invoiceId: 1, productId: 1 });

module.exports = mongoose.model('InvoiceItem', invoiceItemSchema);