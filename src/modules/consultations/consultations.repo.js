// NOTE: lookups by id alone hit every partition's PK index. That's ~14 index
// probes, fine at our size. Clients that know scheduled_at could pass it for pruning.
function createConsultationsRepo(db) {
  return {
    async insert(client, c) {
      const { rows } = await client.query(
        `INSERT INTO consultations (scheduled_at, patient_id, doctor_id, slot_id, reason_enc)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [c.scheduledAt, c.patientId, c.doctorId, c.slotId, c.reasonEnc],
      );
      return rows[0];
    },

    async findById(id, client = db) {
      const { rows } = await client.query('SELECT * FROM consultations WHERE id = $1', [id]);
      return rows[0] || null;
    },

    async lockById(client, id) {
      const { rows } = await client.query('SELECT * FROM consultations WHERE id = $1 FOR UPDATE', [id]);
      return rows[0] || null;
    },

    async update(client, row, fields) {
      const cols = Object.keys(fields);
      const sets = cols.map((c, i) => `${c} = $${i + 3}`).join(', ');
      const { rows } = await client.query(
        `UPDATE consultations SET ${sets} WHERE id = $1 AND scheduled_at = $2 RETURNING *`,
        [row.id, row.scheduled_at, ...cols.map((c) => fields[c])],
      );
      return rows[0];
    },

    async listFor({ userId, role, status, from, to, cursor, limit }) {
      const params = [userId];
      const where = [role === 'doctor' ? 'doctor_id = $1' : 'patient_id = $1'];
      const p = (v) => { params.push(v); return `$${params.length}`; };

      if (status) where.push(`status = ${p(status)}`);
      // from/to also give the planner partition pruning
      if (from) where.push(`scheduled_at >= ${p(from)}`);
      if (to) where.push(`scheduled_at < ${p(to)}`);
      if (cursor) where.push(`(scheduled_at, id) < (${p(cursor.at)}, ${p(cursor.id)})`);

      const { rows } = await db.query(
        `SELECT * FROM consultations WHERE ${where.join(' AND ')}
         ORDER BY scheduled_at DESC, id DESC LIMIT ${p(limit + 1)}`,
        params,
      );
      return rows;
    },

    // pending bookings whose hold ran out but were never cleaned up (lost job etc.)
    async findStaleHolds(limit = 100) {
      const { rows } = await db.query(
        `SELECT c.id FROM consultations c
         JOIN availability_slots s ON s.id = c.slot_id
         WHERE c.status = 'pending' AND s.status = 'held' AND s.held_until < now() - interval '30 seconds'
         LIMIT $1`,
        [limit],
      );
      return rows.map((r) => r.id);
    },
  };
}

module.exports = { createConsultationsRepo };
