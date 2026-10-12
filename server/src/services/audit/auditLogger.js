import AuditLog from '../../models/AuditLog.js';

/** Writes one auditLogs document. Call this for every important action. */
export async function writeAudit({ userId = null, action, entity, entityId = null, before = null, after = null }) {
  return AuditLog.create({
    userId,
    action,
    entity,
    entityId,
    before,
    after,
    at: new Date(),
  });
}
