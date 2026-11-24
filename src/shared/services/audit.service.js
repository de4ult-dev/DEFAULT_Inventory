const AuditLog = require('../models/auditLog');

async function logAudit(
  {
    entityType,
    entityId = null,
    entityNumber = '',
    action,
    reason = '',
    before = null,
    after = null,
    performedBy = null,
    timestamp = new Date(),
  },
  session = null
) {
  const payload = {
    entityType,
    entityId,
    entityNumber,
    action,
    reason,
    before,
    after,
    performedBy,
    timestamp,
  };

  if (session) {
    const [created] = await AuditLog.create([payload], { session });
    return created;
  }

  return AuditLog.create(payload);
}

module.exports = { logAudit };