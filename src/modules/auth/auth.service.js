const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { sha256, randomToken } = require('../../lib/crypto');
const { conflict, unauthorized, AppError, notFound } = require('../../lib/errors');

const BCRYPT_ROUNDS = 11;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_SEC = 15 * 60;
// compared against when the email doesn't exist so response time doesn't leak it
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-123', BCRYPT_ROUNDS);

function createAuthService({ db, redis, config, cipher, authRepo, auditService }) {
  function signAccessToken(user) {
    return jwt.sign({ role: user.role }, config.jwt.accessSecret, {
      subject: user.id,
      expiresIn: config.jwt.accessTtl,
      issuer: 'amrutam-api',
      algorithm: 'HS256',
    });
  }

  async function issueTokens(client, user, familyId = crypto.randomUUID()) {
    const refreshToken = randomToken();
    const expiresAt = new Date(Date.now() + config.jwt.refreshTtlDays * 86400_000);
    await authRepo.insertRefreshToken(client, {
      userId: user.id,
      tokenHash: sha256(refreshToken),
      familyId,
      expiresAt,
    });
    return { accessToken: signAccessToken(user), refreshToken, tokenType: 'Bearer' };
  }

  async function register(input, ctx) {
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    try {
      const user = await db.tx(async (client) => {
        const u = await authRepo.insertUser(client, { email: input.email, passwordHash, role: input.role });
        await authRepo.insertProfile(client, {
          userId: u.id,
          fullName: input.fullName,
          phoneEnc: cipher.encrypt(input.phone),
        });
        if (input.role === 'doctor') await authRepo.insertDoctor(client, u.id, input.doctor);
        return u;
      });

      await auditService.record({ ...ctx, actorId: user.id, actorRole: user.role, action: 'user.register', resourceType: 'user', resourceId: user.id });
      return user;
    } catch (err) {
      if (err.code === '23505') {
        // unique violation - email or registration number
        throw conflict(err.constraint?.includes('registration') ? 'Registration number already in use' : 'Email already registered');
      }
      throw err;
    }
  }

  async function login({ email, password, mfaCode }, ctx) {
    const failKey = `login_fail:${email}`;
    const fails = Number(await redis.get(failKey).catch(() => 0)) || 0;
    if (fails >= MAX_FAILED_LOGINS) {
      throw new AppError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts, try again later');
    }

    const user = await authRepo.findUserByEmail(email);
    const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);

    if (!user || !ok) {
      await redis.multi().incr(failKey).expire(failKey, LOCKOUT_SEC).exec().catch(() => {});
      await auditService.record({ ...ctx, actorId: user?.id, action: 'auth.login_failed', resourceType: 'user', resourceId: user?.id, metadata: { email } });
      throw unauthorized('Invalid email or password');
    }
    if (user.status !== 'active') throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Account is suspended');

    if (user.mfa_enabled) {
      if (!mfaCode) throw unauthorized('MFA code required', { mfaRequired: true });
      if (!verifyMfa(user, mfaCode)) {
        await redis.multi().incr(failKey).expire(failKey, LOCKOUT_SEC).exec().catch(() => {});
        throw unauthorized('Invalid MFA code', { mfaRequired: true });
      }
    }

    await redis.del(failKey).catch(() => {});
    const tokens = await issueTokens(db, user);
    await authRepo.touchLastLogin(user.id);
    await auditService.record({ ...ctx, actorId: user.id, actorRole: user.role, action: 'auth.login', resourceType: 'user', resourceId: user.id });

    return {
      ...tokens,
      user: { id: user.id, email: user.email, role: user.role, mfaEnabled: user.mfa_enabled },
      // doctors/admins must turn on MFA, client should push them to /auth/mfa/setup
      mfaSetupRequired: user.role !== 'patient' && !user.mfa_enabled,
    };
  }

  // placeholder until TOTP lands - MFA is never enabled before that
  function verifyMfa() {
    return false;
  }

  async function refresh(refreshToken, ctx) {
    const row = await authRepo.findRefreshToken(sha256(refreshToken));
    if (!row) throw unauthorized('Invalid refresh token');

    if (row.revoked_at) {
      // an already used token came back -> assume it was stolen, kill the whole chain
      await authRepo.revokeFamily(row.family_id);
      await auditService.record({ ...ctx, actorId: row.user_id, action: 'auth.refresh_reuse_detected', resourceType: 'user', resourceId: row.user_id, metadata: { familyId: row.family_id } });
      throw unauthorized('Refresh token reused, please login again');
    }
    if (row.expires_at < new Date()) throw unauthorized('Refresh token expired');

    return db.tx(async (client) => {
      const won = await authRepo.revokeRefreshToken(client, row.id);
      if (!won) throw unauthorized('Refresh token already used');

      const user = await authRepo.findUserById(row.user_id, client);
      if (!user || user.status !== 'active') throw unauthorized('Account not active');
      return issueTokens(client, user, row.family_id);
    });
  }

  async function logout(refreshToken, ctx) {
    const row = await authRepo.findRefreshToken(sha256(refreshToken));
    if (!row) return;
    await authRepo.revokeFamily(row.family_id);
    await auditService.record({ ...ctx, actorId: row.user_id, action: 'auth.logout', resourceType: 'user', resourceId: row.user_id });
  }

  async function me(userId) {
    const row = await authRepo.getMe(userId);
    if (!row) throw notFound('User');
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      status: row.status,
      mfaEnabled: row.mfa_enabled,
      createdAt: row.created_at,
      profile: {
        fullName: row.full_name,
        phone: cipher.decrypt(row.phone_enc),
        dateOfBirth: row.date_of_birth,
        gender: row.gender,
        city: row.city,
      },
    };
  }

  return { register, login, refresh, logout, me, verifyMfa, signAccessToken };
}

module.exports = { createAuthService };
