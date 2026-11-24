const mongoose = require('mongoose');

const invoiceItemSchema = new mongoose.Schema(
  {
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
    currency: {
      type: String,
      enum: ['USD', 'Kz'],
      required: [true, 'Item currency is required'],
    },
    lineTotal: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    unitCostSnapshot: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { _id: false }
);

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
    items: {
      type: [invoiceItemSchema],
      validate: [
        (val) => Array.isArray(val) && val.length > 0,
        'Invoice must contain at least one item',
      ],
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