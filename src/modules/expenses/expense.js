const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema(
  {
    number: {
      type: String,
      required: [true, 'Expense number is required'],
      unique: true,
      trim: true,
    },
    category: {
      type: String,
      enum: [
        'RENT',
        'SALARIES',
        'UTILITIES',
        'TRANSPORT',
        'OFFICE',
        'MAINTENANCE',
        'OTHER',
      ],
      required: [true, 'Expense category is required'],
      default: 'OTHER',
    },
    amount: {
      type: Number,
      required: [true, 'Expense amount is required'],
      min: 0.01,
    },
    currency: {
      type: String,
      enum: ['USD', 'Kz'],
      required: [true, 'Expense currency is required'],
      default: 'Kz',
    },
    cashboxId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cashbox',
      required: [true, 'Cashbox is required'],
    },
    cashboxNameSnapshot: {
      type: String,
      trim: true,
      default: '',
    },
    paidAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    paidCurrency: {
      type: String,
      enum: ['USD', 'Kz'],
      required: true,
    },
    exchangeRate: {
      type: Number,
      default: 1,
      min: 0,
    },
    isLumpSum: {
      type: Boolean,
      default: true,
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

expenseSchema.index({ category: 1, date: -1 });
expenseSchema.index({ cashboxId: 1, date: -1 });

module.exports = mongoose.model('Expense', expenseSchema);