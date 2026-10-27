function createAuthRepo(db) {
  return {
    async findUserByEmail(email) {
      const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
      return rows[0] || null;
    },

    async findUserById(id, client = db) {
      const { rows } = await client.query('SELECT * FROM users WHERE id = $1', [id]);
      return rows[0] || null;
    },

    async insertUser(client, { email, passwordHash, role }) {
      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)
         RETURNING id, email, role, status, mfa_enabled, created_at`,
        [email, passwordHash, role],
      );
      return rows[0];
    },

    async insertProfile(client, { userId, fullName, phoneEnc }) {
      await client.query(
        'INSERT INTO profiles (user_id, full_name, phone_enc) VALUES ($1, $2, $3)',
        [userId, fullName, phoneEnc],
      );
    },

    async insertDoctor(client, userId, d) {
      await client.query(
        `INSERT INTO doctors (user_id, registration_no, specialization, languages, experience_years, fee_paise, bio)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, d.registrationNo, d.specialization, d.languages, d.experienceYears, d.feeInr * 100, d.bio ?? null],
      );
    },

    async touchLastLogin(userId) {
      await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
    },

    async insertRefreshToken(client, { userId, tokenHash, familyId, expiresAt }) {
      await client.query(
        'INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at) VALUES ($1, $2, $3, $4)',
        [userId, tokenHash, familyId, expiresAt],
      );
    },

    async findRefreshToken(tokenHash) {
      const { rows } = await db.query('SELECT * FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);
      return rows[0] || null;
    },

    // returns true only for the request that actually revoked it (guards concurrent refresh)
    async revokeRefreshToken(client, id) {
      const { rowCount } = await client.query(
        'UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
        [id],
      );
      return rowCount === 1;
    },

    async revokeFamily(familyId) {
      await db.query(
        'UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL',
        [familyId],
      );
    },

    async revokeAllForUser(userId) {
      await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
    },

    async getMe(userId) {
      const { rows } = await db.query(
        `SELECT u.id, u.email, u.role, u.status, u.mfa_enabled, u.created_at,
                p.full_name, p.phone_enc, p.date_of_birth, p.gender, p.city
         FROM users u LEFT JOIN profiles p ON p.user_id = u.id
         WHERE u.id = $1`,
        [userId],
      );
      return rows[0] || null;
    },
  };
}

module.exports = { createAuthRepo };
