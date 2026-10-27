// Compliance trail. Writes are awaited (so a request that touched PHI has its
// log row before we respond) but a failed audit insert doesn't fail the request -
// it is logged at error level and picked up by alerting instead.
function createAuditService({ db, logger }) {
  async function record({ actorId, actorRole, action, resourceType, resourceId, ip, userAgent, requestId, metadata }) {
    try {
      await db.query(
        `INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, resource_id, ip, user_agent, request_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [actorId ?? null, actorRole ?? null, action, resourceType, resourceId ?? null,
          ip ?? null, userAgent?.slice(0, 300) ?? null, requestId ?? null, metadata ?? {}],
      );
    } catch (err) {
      logger.error({ err, action, resourceType, resourceId }, 'audit write failed');
    }
  }

  return { record };
}

// attaches req.auditCtx() so services get who/where without depending on express
function auditContext(req, res, next) {
  req.auditCtx = () => ({
    actorId: req.user?.id,
    actorRole: req.user?.role,
    ip: req.ip,
    userAgent: req.get('user-agent'),
    requestId: req.id,
  });
  next();
}

module.exports = { createAuditService, auditContext };
