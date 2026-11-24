const mongoose = require('mongoose');

const collectionSchema = new mongoose.Schema(
    {
        number: {
            type: String,
            required: [true, 'Collection receipt number is required'],
            unique: true,
            trim: true,
        },
        customerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Customer',
            required: [true, 'Customer is required'],
            index: true,
        },
        customerNameSnapshot: {
            type: String,
            trim: true,
            default: '',
        },
        cashboxId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Cashbox',
            required: [true, 'Cashbox is required'],
        },
        // Currency of the payment received ('USD' or 'Kz')
        paymentCurrency: {
            type: String,
            enum: ['USD', 'Kz'],
            required: true,
        },
        // Currency of the debt being settled ('USD' or 'Kz')
        debtCurrency: {
            type: String,
            enum: ['USD', 'Kz'],
            required: true,
        },
        // Currency of the cashbox receiving the deposit ('USD' or 'Kz')
        cashboxCurrency: {
            type: String,
            enum: ['USD', 'Kz'],
            required: true,
        },
        // Original amount paid by customer in paymentCurrency
        originalAmount: {
            type: Number,
            required: true,
            min: 0,
        },
        // Manual rate (Kz per 1 USD); 1 when no cross-currency conversion is needed
        exchangeRate: {
            type: Number,
            required: true,
            default: 1,
            min: 0,
        },
        // Amount applied to reduce customer debt in debtCurrency
        settledAmount: {
            type: Number,
            required: true,
            min: 0,
        },
        // Amount deposited into cashbox in cashboxCurrency
        cashboxAmount: {
            type: Number,
            required: true,
            min: 0,
        },
        applyMode: {
            type: String,
            enum: ['CUSTOMER_BALANCE', 'SPECIFIC_INVOICES'],
            default: 'CUSTOMER_BALANCE',
        },
        allocations: [
            {
                invoiceId: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: 'Invoice',
                    required: true,
                },
                invoiceNumberSnapshot: {
                    type: String,
                    trim: true,
                    default: '',
                },
                amountSettled: {
                    type: Number,
                    required: true,
                    min: 0,
                },
                currency: {
                    type: String,
                    enum: ['USD', 'Kz'],
                    required: true,
                },
            },
        ],
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

collectionSchema.index({ customerId: 1, date: -1 });
collectionSchema.index({ date: -1 });

module.exports = mongoose.model('Collection', collectionSchema);