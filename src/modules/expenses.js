const mongoose = require('mongoose');

const expenseCategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Category name is required'],
      unique: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

const expenseSchema = new mongoose.Schema(
  {
    number: {
      type: String,
      required: [true, 'Expense number is required'],
      unique: true,
      trim: true,
    },
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ExpenseCategory',
      required: [true, 'Expense category is required'],
    },
    cashboxId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cashbox',
      required: [true, 'Cashbox is required'],
    },
    amount: {
      type: Number,
      required: [true, 'Expense amount is required'],
      min: [0.000001, 'Amount must be greater than zero'],
    },
    currency: {
      type: String,
      enum: ['USD', 'Kz'],
      required: [true, 'Currency is required'],
    },
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },
    note: {
      type: String,
      trim: true,
      default: '',
    },
    status: {
      type: String,
      enum: ['POSTED', 'CANCELLED'],
      default: 'POSTED',
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

expenseSchema.index({ categoryId: 1, date: -1 });
expenseSchema.index({ cashboxId: 1, date: -1 });

const ExpenseCategory = mongoose.model('ExpenseCategory', expenseCategorySchema);
const Expense = mongoose.model('Expense', expenseSchema);

module.exports = { ExpenseCategory, Expense };