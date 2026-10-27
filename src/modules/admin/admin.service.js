const { notFound, badRequest } = require('../../lib/errors');

const num = (v) => Number(v || 0);

function createAdminService({ db, redis, auditService, authRepo }) {
  async function summary({ from, to }) {
    const [totals, daily, top] = await Promise.all([
      db.query(
        `SELECT sum(booked) booked, sum(completed) completed, sum(cancelled) cancelled, sum(no_show) no_show,
                sum(abandoned) abandoned, sum(revenue_paise) revenue_paise, sum(refunded_paise) refunded_paise
         FROM mv_daily_consultation_stats WHERE day BETWEEN $1 AND $2`,
        [from, to],
      ),
      db.query(
        `SELECT day, sum(booked) booked, sum(completed) completed, sum(cancelled) cancelled, sum(revenue_paise) revenue_paise
         FROM mv_daily_consultation_stats WHERE day BETWEEN $1 AND $2
         GROUP BY day ORDER BY day`,
        [from, to],
      ),
      db.query(
        `SELECT s.doctor_id, p.full_name, d.specialization, sum(s.completed) completed, sum(s.revenue_paise) revenue_paise
         FROM mv_daily_consultation_stats s
         JOIN doctors d ON d.user_id = s.doctor_id
         JOIN profiles p ON p.user_id = s.doctor_id
         WHERE s.day BETWEEN $1 AND $2
         GROUP BY 1, 2, 3 ORDER BY completed DESC, revenue_paise DESC LIMIT 10`,
        [from, to],
      ),
    ]);

    const t = totals.rows[0];
    const paidBookings = num(t.booked) - num(t.abandoned);
    return {
      range: { from, to },
      refreshedAt: await redis.get('analytics:refreshed_at').catch(() => null),
      totals: {
        booked: num(t.booked),
        completed: num(t.completed),
        cancelled: num(t.cancelled),
        noShow: num(t.no_show),
        abandoned: num(t.abandoned),
        revenueInr: num(t.revenue_paise) / 100,
        refundedInr: num(t.refunded_paise) / 100,
        cancellationRate: paidBookings ? +(num(t.cancelled) / paidBookings).toFixed(3) : 0,
        noShowRate: paidBookings ? +(num(t.no_show) / paidBookings).toFixed(3) : 0,
      },
      daily: daily.rows.map((r) => ({
        day: r.day, booked: num(r.booked), completed: num(r.completed), cancelled: num(r.cancelled), revenueInr: num(r.revenue_paise) / 100,
      })),
      topDoctors: top.rows.map((r) => ({
        doctorId: r.doctor_id, name: r.full_name, specialization: r.specialization, completed: num(r.completed), revenueInr: num(r.revenue_paise) / 100,
      })),
    };
  }

  // today straight from the source table - only touches the current partition
  async function live() {
    const { rows } = await db.query(
      `SELECT status, count(*) n FROM consultations
       WHERE scheduled_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')
         AND scheduled_at <  (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') + interval '1 day'
       GROUP BY status`,
    );
    return { today: Object.fromEntries(rows.map((r) => [r.status, num(r.n)])) };
  }

  async function refreshStats() {
    await db.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_consultation_stats');
    await redis.set('analytics:refreshed_at', new Date().toISOString()).catch(() => {});
  }

  async function auditLogs(f) {
    const where = [];
    const params = [];
    const p = (v) => { params.push(v); return `$${params.length}`; };
    if (f.actorId) where.push(`actor_id = ${p(f.actorId)}`);
    if (f.action) where.push(`action = ${p(f.action)}`);
    if (f.resourceType) where.push(`resource_type = ${p(f.resourceType)}`);
    if (f.resourceId) where.push(`resource_id = ${p(f.resourceId)}`);
    if (f.from) where.push(`created_at >= ${p(f.from)}`);
    if (f.to) where.push(`created_at < ${p(f.to)}`);
    if (f.cursor) {
      let cur;
      try {
        cur = JSON.parse(Buffer.from(f.cursor, 'base64url').toString());
      } catch {
        throw badRequest('Invalid cursor');
      }
      where.push(`(created_at, id) < (${p(cur.at)}, ${p(cur.id)})`);
    }

    const { rows } = await db.query(
      `SELECT id, created_at, actor_id, actor_role, action, resource_type, resource_id, host(ip) ip, request_id, metadata
       FROM audit_logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC LIMIT ${p(f.limit + 1)}`,
      params,
    );
    const hasMore = rows.length > f.limit;
    const page = hasMore ? rows.slice(0, f.limit) : rows;
    const last = page[page.length - 1];
    return {
      data: page,
      nextCursor: hasMore ? Buffer.from(JSON.stringify({ at: last.created_at, id: last.id })).toString('base64url') : null,
    };
  }

  async function setUserStatus(userId, status, ctx) {
    const { rowCount } = await db.query("UPDATE users SET status = $2 WHERE id = $1 AND role <> 'admin'", [userId, status]);
    if (!rowCount) throw notFound('User');
    // access tokens die within 15 min on their own; refresh tokens die now
    if (status === 'suspended') await authRepo.revokeAllForUser(userId);
    await auditService.record({ ...ctx, action: `user.${status}`, resourceType: 'user', resourceId: userId });
    return { id: userId, status };
  }

  return { summary, live, refreshStats, auditLogs, setUserStatus };
}

module.exports = { createAdminService };
