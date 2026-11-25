const mongoose = require('mongoose');

const containerItemSchema = new mongoose.Schema(
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
    fobUnitCost: {
      type: Number,
      required: [true, 'FOB unit cost is required'],
      min: [0, 'FOB unit cost cannot be negative'],
    },
    fobCurrency: {
      type: String,
      enum: ['USD', 'Kz'],
      required: true,
      default: 'USD',
    },
    allocatedExtraCost: {
      type: Number,
      default: 0,
      min: 0,
    },
    finalLandedUnitCost: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { _id: false }
);

const containerSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: [true, 'Container code/number is required'],
      unique: true,
      trim: true,
      uppercase: true,
    },
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Supplier',
      required: [true, 'External supplier reference is required'],
    },
    status: {
      type: String,
      enum: ['IN_TRANSIT', 'AT_PORT', 'CLEARED', 'RECEIVED', 'CANCELLED'],
      default: 'IN_TRANSIT',
    },
    items: {
      type: [containerItemSchema],
      validate: [
        (val) => Array.isArray(val) && val.length > 0,
        'Container must contain at least one item',
      ],
    },
    additionalCosts: {
      freight: { type: Number, default: 0, min: 0 },
      customs: { type: Number, default: 0, min: 0 },
      clearance: { type: Number, default: 0, min: 0 },
      transport: { type: Number, default: 0, min: 0 },
      other: { type: Number, default: 0, min: 0 },
    },
    costCurrency: {
      type: String,
      enum: ['USD', 'Kz'],
      required: true,
      default: 'Kz',
    },
    allocationMethod: {
      type: String,
      enum: ['BY_VALUE'],
      default: 'BY_VALUE',
    },
    receivedAt: {
      type: Date,
      default: null,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    cancelReason: {
      type: String,
      trim: true,
      default: '',
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

containerSchema.index({ supplierId: 1, status: 1 });
containerSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Container', containerSchema);