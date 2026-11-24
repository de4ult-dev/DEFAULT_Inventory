const mongoose = require('mongoose');

const purchaseItemSchema = new mongoose.Schema(
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
    unitCost: {
      type: Number,
      required: [true, 'Unit cost is required'],
      min: [0, 'Unit cost cannot be negative'],
    },
    currency: {
      type: String,
      enum: ['USD', 'Kz'],
      required: true,
      default: 'Kz',
    },
    lineTotal: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
  },
  { _id: false }
);

const purchaseSchema = new mongoose.Schema(
  {
    number: {
      type: String,
      required: [true, 'Purchase number is required'],
      unique: true,
      trim: true,
    },
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Supplier',
      required: [true, 'Supplier reference is required'],
    },
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },
    items: {
      type: [purchaseItemSchema],
      validate: [
        (val) => Array.isArray(val) && val.length > 0,
        'Purchase must contain at least one item',
      ],
    },
    totals: {
      usd: { type: Number, default: 0, min: 0 },
      kz: { type: Number, default: 0, min: 0 },
    },
    isReceived: {
      type: Boolean,
      default: false,
    },
    receivedAt: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ['DRAFT', 'RECEIVED', 'CANCELLED'],
      default: 'DRAFT',
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

purchaseSchema.index({ supplierId: 1, date: -1 });
purchaseSchema.index({ status: 1, date: -1 });

module.exports = mongoose.model('Purchase', purchaseSchema);