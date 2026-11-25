const mongoose = require('mongoose');

const exchangeSideSchema = new mongoose.Schema(
    {
        productId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Product',
            required: true,
        },
        skuSnapshot: { type: String, trim: true, default: '' },
        nameSnapshot: { type: String, trim: true, default: '' },
        stockBucket: {
            type: String,
            enum: ['AVAILABLE', 'DAMAGED'],
            default: 'AVAILABLE',
        },
        quantity: { type: Number, required: true, min: 0 },
        unitCost: { type: Number, required: true, min: 0 },
        currency: { type: String, enum: ['USD', 'Kz'], required: true },
        totalValue: { type: Number, required: true, min: 0 },
    },
    { _id: false }
);

const productExchangeSchema = new mongoose.Schema(
    {
        number: {
            type: String,
            required: [true, 'Exchange number is required'],
            unique: true,
            trim: true,
        },
        status: {
            type: String,
            enum: ['POSTED', 'CANCELLED'],
            default: 'POSTED',
        },
        customerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Customer',
            default: null,
        },
        customerNameSnapshot: {
            type: String,
            trim: true,
            default: '',
        },
        outgoing: {
            type: exchangeSideSchema,
            required: true,
        },
        incoming: {
            type: exchangeSideSchema,
            required: true,
        },
        exchangeRate: {
            type: Number,
            default: 1,
            min: 0,
        },
        reason: {
            type: String,
            trim: true,
            default: '',
        },
        date: {
            type: Date,
            required: true,
            default: Date.now,
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
    },
    { timestamps: true }
);

productExchangeSchema.index({ date: -1 });
productExchangeSchema.index({ status: 1, date: -1 });
productExchangeSchema.index({ customerId: 1, date: -1 });

module.exports = mongoose.model('ProductExchange', productExchangeSchema);