const mongoose = require('mongoose');

const cashMoveSchema = new mongoose.Schema(
  {
    cashboxId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cashbox',
      required: [true, 'Cashbox reference is required'],
    },
    direction: {
      type: String,
      enum: ['IN', 'OUT'],
      required: [true, 'Movement direction is required'],
    },
    amount: {
      type: Number,
      required: [true, 'Amount is required'],
      min: [0.000001, 'Amount must be greater than zero'],
    },
    currency: {
      type: String,
      enum: ['USD', 'Kz'],
      required: [true, 'Currency is required'],
    },
    balanceBefore: {
      type: Number,
      required: true,
      min: [0, 'Balance before cannot be negative'],
    },
    balanceAfter: {
      type: Number,
      required: true,
      min: [0, 'Balance after cannot be negative'],
    },
    category: {
      type: String,
      enum: [
        'INVOICE_PAYMENT',
        'CUSTOMER_COLLECTION',
        'SUPPLIER_PAYMENT',
        'CONTAINER_COST',
        'RETURN_REFUND',
        'EXPENSE',
        'EXPENSE_REVERSAL',
        'COLLECTION_REVERSAL',
        'REVERSAL',
        'CASHBOX_TRANSFER',
        'OPENING_BALANCE',
      ],
      required: true,
    },
    referenceType: {
      type: String,
      enum: [
        'INVOICE',
        'CUSTOMER',
        'SUPPLIER',
        'CONTAINER',
        'RETURN',
        'EXPENSE',
        'TRANSFER',
        'OPENING',
        'CASH_MOVE',
      ],
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
    description: {
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

cashMoveSchema.index({ cashboxId: 1, date: -1 });
cashMoveSchema.index({ referenceType: 1, referenceId: 1 });
cashMoveSchema.index({ referenceNumber: 1, date: -1 });

module.exports = mongoose.model('CashMove', cashMoveSchema);