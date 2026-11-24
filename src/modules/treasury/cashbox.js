const mongoose = require('mongoose');

const cashboxSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Cashbox name is required'],
      trim: true,
    },
    currency: {
      type: String,
      enum: ['USD', 'Kz'],
      required: [true, 'Cashbox currency is required'],
    },
    // Strict block: balance can never go below 0
    balance: {
      type: Number,
      required: true,
      default: 0,
      min: [0, 'Cashbox balance cannot be negative'],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

cashboxSchema.index({ currency: 1, isActive: 1 });

module.exports = mongoose.model('Cashbox', cashboxSchema);