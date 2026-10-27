// Integration tests run against real postgres + redis (docker compose locally,
// service containers in CI). Every test creates its own users so runs don't collide.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const { createContainer } = require('../../src/container');
const { createApp } = require('../../src/app');

const PASSWORD = 'Password123';
const HASH = bcrypt.hashSync(PASSWORD, 4);

function setup() {
  const c = createContainer();
  const app = createApp(c);
  const api = () => request(app);
  const uid = () => crypto.randomBytes(5).toString('hex');

  async function createUser(role, extra = {}) {
    const email = `${role}-${uid()}@test.local`;
    const { rows } = await c.db.query(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
      [email, HASH, role],
    );
    const id = rows[0].id;
    await c.db.query('INSERT INTO profiles (user_id, full_name) VALUES ($1, $2)', [id, extra.name || `Test ${role}`]);
    if (role === 'doctor') {
      await c.db.query(
        `INSERT INTO doctors (user_id, registration_no, specialization, fee_paise, is_verified)
         VALUES ($1, $2, 'Ayurveda', 50000, $3)`,
        [id, `REG-${uid()}`, extra.verified ?? true],
      );
    }
    const res = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
    return { id, email, token: res.body.accessToken, refreshToken: res.body.refreshToken };
  }

  async function createSlot(doctorId, minutesFromNow = 24 * 60) {
    const start = new Date(Date.now() + minutesFromNow * 60_000);
    const { rows } = await c.db.query(
      'INSERT INTO availability_slots (doctor_id, starts_at, ends_at) VALUES ($1, $2, $3) RETURNING id',
      [doctorId, start, new Date(+start + 30 * 60_000)],
    );
    return rows[0].id;
  }

  const book = (token, slotId, key = crypto.randomUUID(), body = {}) =>
    api().post('/api/v1/bookings').set('authorization', `Bearer ${token}`).set('idempotency-key', key).send({ slotId, ...body });

  const slotStatus = async (id) => (await c.db.query('SELECT status FROM availability_slots WHERE id = $1', [id])).rows[0].status;
  const consultation = async (id) => (await c.db.query('SELECT * FROM consultations WHERE id = $1', [id])).rows[0];
  const payment = async (id) => (await c.db.query('SELECT * FROM payments WHERE id = $1', [id])).rows[0];

  return { c, api, createUser, createSlot, book, slotStatus, consultation, payment, close: () => c.close() };
}

module.exports = { setup, PASSWORD };
