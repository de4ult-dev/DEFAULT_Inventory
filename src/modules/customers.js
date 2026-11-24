const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'Customer name is required'],
            trim: true,
        },
        type: {
            type: String,
            enum: ['CASH', 'CREDIT', 'WHOLESALE'],
            default: 'CASH',
        },
        phone: {
            type: String,
            trim: true,
            default: '',
        },
        whatsapp: {
            type: String,
            trim: true,
            default: '',
        },
        address: {
            type: String,
            trim: true,
            default: '',
        },
        taxId: {
            type: String,
            trim: true,
            default: '',
        },
        notes: {
            type: String,
            trim: true,
            default: '',
        },
        balances: {
            usd: { type: Number, default: 0 },
            kz: { type: Number, default: 0 },
        },
        // رصيد دائن / مقدم للعميل (اختياري ومنفصل لكل عملة)
        creditBalances: {
            usd: { type: Number, default: 0, min: 0 },
            kz: { type: Number, default: 0, min: 0 },
        },
        // حد ائتماني اختياري لكل عملة
        creditLimits: {
            usd: { type: Number, default: null, min: 0 },
            kz: { type: Number, default: null, min: 0 },
        },
        isActive: {
            type: Boolean,
            default: true,
        },
    },
    { timestamps: true }
);

customerSchema.index({ name: 1 });
customerSchema.index({ phone: 1 });

module.exports = mongoose.model('Customer', customerSchema);