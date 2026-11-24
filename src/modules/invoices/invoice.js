const mongoose = require('mongoose');

const invoiceSchema = new mongoose.Schema(
  {
    number: {
      type: String,
      required: [true, 'Invoice number is required'],
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
    type: {
      type: String,
      enum: ['CASH', 'CREDIT', 'WHOLESALE', 'MIXED'],
      required: true,
      default: 'CASH',
    },
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },
    // Independent totals per currency (no auto-conversion between USD and Kz)
    totals: {
      usd: { type: Number, default: 0, min: 0 },
      kz: { type: Number, default: 0, min: 0 },
    },
    paidAmount: {
      usd: { type: Number, default: 0, min: 0 },
      kz: { type: Number, default: 0, min: 0 },
    },
    remainingAmount: {
      usd: { type: Number, default: 0, min: 0 },
      kz: { type: Number, default: 0, min: 0 },
    },
    status: {
      type: String,
      enum: ['PAID', 'UNPAID', 'PARTIAL', 'CANCELLED'],
      default: 'UNPAID',
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

invoiceSchema.index({ customerId: 1, date: -1 });
invoiceSchema.index({ status: 1, date: -1 });

module.exports = mongoose.model('Invoice', invoiceSchema);