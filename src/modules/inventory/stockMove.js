const mongoose = require('mongoose');

const stockMoveSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'Product reference is required'],
    },
    direction: {
      type: String,
      enum: ['IN', 'OUT'],
      required: [true, 'Movement direction is required'],
    },
    stockBucket: {
      type: String,
      enum: ['AVAILABLE', 'DAMAGED'],
      required: [true, 'Stock bucket is required'],
      default: 'AVAILABLE',
    },
    quantity: {
      type: Number,
      required: [true, 'Quantity is required'],
      min: [0.000001, 'Quantity must be greater than zero'],
    },
    unitCost: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    totalCost: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    currency: {
      type: String,
      enum: ['USD', 'Kz'],
      required: [true, 'Currency is required'],
    },
    referenceType: {
      type: String,
      enum: ['INVOICE', 'RETURN', 'PURCHASE', 'CONTAINER', 'OPENING', 'ADJUSTMENT'],
      required: true,
    },
    referenceId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    referenceNumber: {
      type: String,
      trim: true,
      default: '',
    },
    reason: {
      type: String,
      trim: true,
      default: '',
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    date: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

stockMoveSchema.index({ productId: 1, date: -1 });
stockMoveSchema.index({ referenceType: 1, referenceId: 1 });

module.exports = mongoose.model('StockMove', stockMoveSchema);