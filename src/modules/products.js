const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    sku: {
      type: String,
      required: [true, 'SKU is required'],
      unique: true,
      trim: true,
      uppercase: true,
    },
    name: {
      type: String,
      required: [true, 'Product name is required'],
      trim: true,
    },
    currency: {
      type: String,
      enum: ['USD', 'Kz'],
      required: [true, 'Product currency is required'],
      default: 'Kz',
    },
    prices: {
      cash: { type: Number, required: true, default: 0, min: 0 },
      credit: { type: Number, required: true, default: 0, min: 0 },
      wholesale: { type: Number, required: true, default: 0, min: 0 },
    },
    // Moving weighted average unit cost (in product currency; 0 until stock is received)
    cost: {
      type: Number,
      default: 0,
      min: 0,
    },
    stock: {
      available: {
        type: Number,
        default: 0,
        min: [0, 'Available stock cannot be negative'],
      },
      damaged: {
        type: Number,
        default: 0,
        min: [0, 'Damaged stock cannot be negative'],
      },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

productSchema.index({ name: 1 });
productSchema.index({ currency: 1, isActive: 1 });

module.exports = mongoose.model('Product', productSchema);