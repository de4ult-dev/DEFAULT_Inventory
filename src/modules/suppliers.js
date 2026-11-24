const mongoose = require('mongoose');

const supplierSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'Supplier name is required'],
            trim: true,
        },
        type: {
            type: String,
            enum: ['LOCAL', 'EXTERNAL'],
            required: true,
            default: 'LOCAL',
        },
        defaultCurrency: {
            type: String,
            enum: ['USD', 'Kz'],
            default: 'Kz',
        },
        phone: {
            type: String,
            trim: true,
            default: '',
        },
        address: {
            type: String,
            trim: true,
            default: '',
        },
        notes: {
            type: String,
            trim: true,
            default: '',
        },
        // المستحق للمورد (منفصل تماماً لكل عملة)
        balances: {
            usd: { type: Number, default: 0 },
            kz: { type: Number, default: 0 },
        },
        isActive: {
            type: Boolean,
            default: true,
        },
    },
    { timestamps: true }
);

supplierSchema.pre('validate', function () {
    if (!this.defaultCurrency) {
        this.defaultCurrency = this.type === 'EXTERNAL' ? 'USD' : 'Kz';
    }
});

supplierSchema.index({ name: 1 });
supplierSchema.index({ type: 1, isActive: 1 });

module.exports = mongoose.model('Supplier', supplierSchema);