const crypto = require('crypto');
const { notFound, badRequest } = require('../../lib/errors');

const SEARCH_TTL = 60;
const PROFILE_TTL = 300;

const toDto = (r) => ({
  id: r.id,
  fullName: r.full_name,
  city: r.city,
  specialization: r.specialization,
  languages: r.languages,
  experienceYears: r.experience_years,
  feeInr: r.fee_paise / 100,
  bio: r.bio,
  rating: Number(r.rating_avg),
  ratingCount: r.rating_count,
  verified: r.is_verified,
});

const encodeCursor = (row) => Buffer.from(JSON.stringify({ v: row.sort_value, id: row.id })).toString('base64url');
function decodeCursor(c) {
  try {
    const parsed = JSON.parse(Buffer.from(c, 'base64url').toString());
    if (parsed && parsed.id && parsed.v !== undefined) return parsed;
  } catch { /* fallthrough */ }
  throw badRequest('Invalid cursor');
}

function createDoctorsService({ doctorsRepo, cache, auditService }) {
  async function search(filters) {
    const f = { ...filters, cursor: filters.cursor ? decodeCursor(filters.cursor) : null };
    // listings change rarely and are hit a lot - a short ttl is good enough,
    // the version bump on doctor updates clears it early
    const ver = await cache.version('doctors');
    const key = `search:${ver}:${crypto.createHash('sha1').update(JSON.stringify(filters)).digest('hex')}`;

    return cache.getOrSet(key, SEARCH_TTL, async () => {
      const rows = await doctorsRepo.search(f);
      const hasMore = rows.length > f.limit;
      const page = hasMore ? rows.slice(0, f.limit) : rows;
      return {
        data: page.map(toDto),
        nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
      };
    });
  }

  async function getById(id, { includeUnverified = false } = {}) {
    const doc = await cache.getOrSet(`doctor:${id}`, PROFILE_TTL, async () => {
      const row = await doctorsRepo.findById(id);
      return row ? toDto(row) : null;
    });
    if (!doc || (!doc.verified && !includeUnverified)) throw notFound('Doctor');
    return doc;
  }

  async function invalidate(id) {
    await cache.del(`doctor:${id}`);
    await cache.bump('doctors');
  }

  async function updateOwn(doctorId, fields, ctx) {
    await doctorsRepo.update(doctorId, fields);
    await invalidate(doctorId);
    await auditService.record({ ...ctx, action: 'doctor.update', resourceType: 'doctor', resourceId: doctorId, metadata: { fields: Object.keys(fields) } });
    return getById(doctorId, { includeUnverified: true });
  }

  async function setVerified(doctorId, verified, ctx) {
    const ok = await doctorsRepo.setVerified(doctorId, verified);
    if (!ok) throw notFound('Doctor');
    await invalidate(doctorId);
    await auditService.record({ ...ctx, action: verified ? 'doctor.verify' : 'doctor.unverify', resourceType: 'doctor', resourceId: doctorId });
    return getById(doctorId, { includeUnverified: true });
  }

  return { search, getById, updateOwn, setVerified };
}

module.exports = { createDoctorsService };
