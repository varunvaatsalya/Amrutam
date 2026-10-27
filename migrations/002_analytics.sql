-- Per day, per doctor rollup for the admin dashboard. Refreshed by the worker
-- every 15 min (CONCURRENTLY, so reads are never blocked). Dashboards read
-- this instead of scanning millions of consultation rows.
CREATE MATERIALIZED VIEW mv_daily_consultation_stats AS
SELECT
  (c.scheduled_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
  c.doctor_id,
  count(*)                                                    AS booked,
  count(*) FILTER (WHERE c.status = 'completed')              AS completed,
  count(*) FILTER (WHERE c.status = 'no_show')                AS no_show,
  -- abandoned = never paid (hold expired / payment failed), not a real cancellation
  count(*) FILTER (WHERE c.status = 'cancelled' AND c.cancel_reason IN ('hold_expired', 'payment_failed')) AS abandoned,
  count(*) FILTER (WHERE c.status = 'cancelled' AND c.cancel_reason NOT IN ('hold_expired', 'payment_failed')) AS cancelled,
  coalesce(sum(p.amount_paise) FILTER (WHERE p.status = 'succeeded'), 0) AS revenue_paise,
  coalesce(sum(p.amount_paise) FILTER (WHERE p.status = 'refunded'), 0)  AS refunded_paise
FROM consultations c
LEFT JOIN payments p ON p.consultation_id = c.id
GROUP BY 1, 2;

-- required for REFRESH ... CONCURRENTLY
CREATE UNIQUE INDEX uq_mv_daily_stats ON mv_daily_consultation_stats (day, doctor_id);
