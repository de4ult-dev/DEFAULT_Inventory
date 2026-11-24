const mongoose = require('mongoose');

const returnItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'Product reference is required'],
    },
    quantity: {
      type: Number,
      required: [true, 'Quantity is required'],
      min: [0.000001, 'Quantity must be greater than zero'],
    },
    unitPrice: {
      type: Number,
      required: [true, 'Unit refund price is required'],
      min: [0, 'Unit price cannot be negative'],
    },
    currency: {
      type: String,
      enum: ['USD', 'Kz'],
      required: [true, 'Return item currency is required'],
    },
    lineTotal: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    stockBucket: {
      type: String,
      enum: ['AVAILABLE', 'DAMAGED'],
      required: [true, 'Stock bucket is required'],
      default: 'AVAILABLE',
    },
    reason: {
      type: String,
      trim: true,
      default: '',
    },
  },
  { _id: false }
);

const returnSchema = new mongoose.Schema(
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
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Invoice',
      default: null,
    },
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },
    items: {
      type: [returnItemSchema],
      validate: [
        (val) => Array.isArray(val) && val.length > 0,
        'Return must contain at least one item',
      ],
    },
    totals: {
      usd: { type: Number, default: 0, min: 0 },
      kz: { type: Number, default: 0, min: 0 },
    },
    refundMethod: {
      type: String,
      enum: ['CASHBOX', 'CUSTOMER_BALANCE', 'MIXED'],
      default: 'CASHBOX',
    },
    cashboxId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cashbox',
      default: null,
    },
    status: {
      type: String,
      enum: ['POSTED', 'CANCELLED'],
      default: 'POSTED',
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

returnSchema.index({ customerId: 1, date: -1 });
returnSchema.index({ status: 1, date: -1 });

module.exports = mongoose.model('Return', returnSchema);