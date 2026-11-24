const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    number: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Invoice',
      default: null,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      default: null,
    },
    cashboxId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cashbox',
      required: true,
    },
    // Currency of the invoice obligation being settled ('USD' or 'Kz')
    invoiceCurrency: {
      type: String,
      enum: ['USD', 'Kz'],
      required: true,
    },
    // Currency of the cashbox receiving the money ('USD' or 'Kz')
    cashboxCurrency: {
      type: String,
      enum: ['USD', 'Kz'],
      required: true,
    },
    // Original amount paid in paymentCurrency
    originalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    paymentCurrency: {
      type: String,
      enum: ['USD', 'Kz'],
      required: true,
    },
    // Manual exchange rate when paying across currencies (1 when same currency)
    exchangeRate: {
      type: Number,
      default: 1,
      min: 0,
    },
    // Amount credited toward the invoice in invoiceCurrency
    settledAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    // Amount actually deposited into the cashbox in cashboxCurrency
    cashboxAmount: {
      type: Number,
      required: true,
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

paymentSchema.index({ invoiceId: 1, date: -1 });
paymentSchema.index({ customerId: 1, date: -1 });

module.exports = mongoose.model('Payment', paymentSchema);
