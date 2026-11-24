const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    entityType: {
      type: String,
      required: [true, 'Entity type is required'],
      trim: true,
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    entityNumber: {
      type: String,
      trim: true,
      default: '',
    },
    action: {
      type: String,
      enum: [
        'CREATE',
        'UPDATE',
        'DELETE',
        'POST',
        'RECEIVE',
        'CANCEL',
        'OVERRIDE',
        'TRANSFER',
      ],
      required: true,
    },
    reason: {
      type: String,
      trim: true,
      default: '',
    },
    before: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    after: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

auditLogSchema.index({ entityType: 1, entityId: 1, timestamp: -1 });
auditLogSchema.index({ performedBy: 1, timestamp: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);