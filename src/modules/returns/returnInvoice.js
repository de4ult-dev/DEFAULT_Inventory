const mongoose = require('mongoose');

const returnItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    skuSnapshot: {
      type: String,
      trim: true,
      required: true,
    },
    nameSnapshot: {
      type: String,
      trim: true,
      required: true,
    },
    stockBucket: {
      type: String,
      enum: ['AVAILABLE', 'DAMAGED'],
      default: 'AVAILABLE',
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },
    unitPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      enum: ['USD', 'Kz'],
      required: true,
    },
    lineTotal: {
      type: Number,
      required: true,
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
    items: {
      type: [returnItemSchema],
      default: [],
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