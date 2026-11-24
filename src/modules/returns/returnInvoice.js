const mongoose = require('mongoose');

const returnInvoiceSchema = new mongoose.Schema(
  {
    number: {
      type: String,
      required: [true, 'Return number is required'],
      unique: true,
      trim: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      default: null,
    },
    customerNameSnapshot: {
      type: String,
      trim: true,
      default: 'Walk-in Customer',
    },
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },
    totals: {
      usd: { type: Number, default: 0, min: 0 },
      kz: { type: Number, default: 0, min: 0 },
    },
    refundedAmount: {
      usd: { type: Number, default: 0, min: 0 },
      kz: { type: Number, default: 0, min: 0 },
    },
    creditedAmount: {
      usd: { type: Number, default: 0, min: 0 },
      kz: { type: Number, default: 0, min: 0 },
    },
    reason: {
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

returnInvoiceSchema.index({ customerId: 1, date: -1 });
returnInvoiceSchema.index({ date: -1 });

module.exports = mongoose.model('ReturnInvoice', returnInvoiceSchema);