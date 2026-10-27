function createPaymentsRepo(db) {
  return {
    async insert(client, p) {
      const { rows } = await client.query(
        `INSERT INTO payments (consultation_id, consultation_scheduled_at, patient_id, amount_paise)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [p.consultationId, p.scheduledAt, p.patientId, p.amountPaise],
      );
      return rows[0];
    },

    async findById(id) {
      const { rows } = await db.query('SELECT * FROM payments WHERE id = $1', [id]);
      return rows[0] || null;
    },

    async lockById(client, id) {
      const { rows } = await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [id]);
      return rows[0] || null;
    },

    async lockLatestForConsultation(client, consultationId) {
      const { rows } = await client.query(
        'SELECT * FROM payments WHERE consultation_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
        [consultationId],
      );
      return rows[0] || null;
    },

    async update(client, id, fields) {
      const cols = Object.keys(fields);
      const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      const { rows } = await client.query(
        `UPDATE payments SET ${sets} WHERE id = $1 RETURNING *`,
        [id, ...cols.map((c) => fields[c])],
      );
      return rows[0];
    },
  };
}

module.exports = { createPaymentsRepo };
