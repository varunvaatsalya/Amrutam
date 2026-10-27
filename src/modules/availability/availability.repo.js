function createAvailabilityRepo(db) {
  return {
    // single round trip for the whole batch
    async insertMany(doctorId, slots) {
      const { rows } = await db.query(
        `INSERT INTO availability_slots (doctor_id, starts_at, ends_at)
         SELECT $1, s, e FROM unnest($2::timestamptz[], $3::timestamptz[]) AS t(s, e)
         RETURNING id, starts_at, ends_at, status`,
        [doctorId, slots.map((s) => s.startsAt), slots.map((s) => s.endsAt)],
      );
      return rows;
    },

    async listOpen(doctorId, from, to) {
      const { rows } = await db.query(
        `SELECT id, starts_at, ends_at FROM availability_slots
         WHERE doctor_id = $1 AND status = 'open' AND starts_at > now()
           AND starts_at >= $2 AND starts_at < $3
         ORDER BY starts_at`,
        [doctorId, from, to],
      );
      return rows;
    },

    async listForDoctor(doctorId, from, to) {
      const { rows } = await db.query(
        `SELECT id, starts_at, ends_at, status, held_until FROM availability_slots
         WHERE doctor_id = $1 AND starts_at >= $2 AND starts_at < $3
         ORDER BY starts_at`,
        [doctorId, from, to],
      );
      return rows;
    },

    async block(doctorId, slotId) {
      const { rows } = await db.query(
        `UPDATE availability_slots SET status = 'blocked'
         WHERE id = $1 AND doctor_id = $2 AND status = 'open'
         RETURNING id, status`,
        [slotId, doctorId],
      );
      return rows[0] || null;
    },

    async lockForBooking(client, slotId) {
      const { rows } = await client.query(
        `SELECT s.*, d.fee_paise, d.is_verified
         FROM availability_slots s JOIN doctors d ON d.user_id = s.doctor_id
         WHERE s.id = $1 FOR UPDATE OF s`,
        [slotId],
      );
      return rows[0] || null;
    },

    async setStatus(client, slotId, status, heldUntil = null) {
      await client.query('UPDATE availability_slots SET status = $2, held_until = $3 WHERE id = $1', [slotId, status, heldUntil]);
    },
  };
}

module.exports = { createAvailabilityRepo };
