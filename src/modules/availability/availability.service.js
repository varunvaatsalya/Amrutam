const { conflict, notFound, badRequest } = require('../../lib/errors');

const LIST_TTL = 30;
const MAX_RANGE_DAYS = 31;
const IST_OFFSET_MS = 330 * 60_000;

const toDto = (r) => ({ id: r.id, startsAt: r.starts_at, endsAt: r.ends_at, status: r.status, heldUntil: r.held_until ?? undefined });

// "2026-10-28" in IST -> Date of its midnight
const istMidnight = (date) => new Date(Date.parse(`${date}T00:00:00Z`) - IST_OFFSET_MS);
const istToday = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

function expand({ from, to, durationMinutes }) {
  const out = [];
  const step = durationMinutes * 60_000;
  for (let t = from.getTime(); t + step <= to.getTime(); t += step) {
    out.push({ startsAt: new Date(t), endsAt: new Date(t + step) });
  }
  return out;
}

function createAvailabilityService({ availabilityRepo, cache, auditService }) {
  async function createSlots(doctorId, input, ctx) {
    const slots = input.slots ?? expand(input.generate);
    if (!slots.length) throw badRequest('No slots in the given range');
    if (slots.length > 200) throw badRequest('At most 200 slots per request');
    if (slots.some((s) => s.startsAt <= new Date())) throw badRequest('Slots must be in the future');

    let rows;
    try {
      rows = await availabilityRepo.insertMany(doctorId, slots);
    } catch (err) {
      // exclusion constraint - overlaps an existing slot (or each other)
      if (err.code === '23P01') throw conflict('One or more slots overlap existing availability', 'SLOT_OVERLAP');
      throw err;
    }

    await cache.bump(`slots:${doctorId}`);
    await auditService.record({ ...ctx, action: 'slots.create', resourceType: 'doctor', resourceId: doctorId, metadata: { count: rows.length } });
    return rows.map(toDto);
  }

  function resolveRange({ from, to }) {
    const f = from || istToday();
    const t = to || addDays(f, 7);
    const start = istMidnight(f);
    const end = istMidnight(addDays(t, 1));
    if (end <= start) throw badRequest('`to` must be on or after `from`');
    if (end - start > MAX_RANGE_DAYS * 86400_000) throw badRequest(`Range can be at most ${MAX_RANGE_DAYS} days`);
    return { f, t, start, end };
  }

  async function listOpen(doctorId, range) {
    const { f, t, start, end } = resolveRange(range);
    const ver = await cache.version(`slots:${doctorId}`);
    return cache.getOrSet(`slots:${doctorId}:${ver}:${f}:${t}`, LIST_TTL, async () =>
      (await availabilityRepo.listOpen(doctorId, start, end)).map(toDto));
  }

  async function listMine(doctorId, range) {
    const { start, end } = resolveRange(range);
    return (await availabilityRepo.listForDoctor(doctorId, start, end)).map(toDto);
  }

  async function block(doctorId, slotId, ctx) {
    const row = await availabilityRepo.block(doctorId, slotId);
    if (!row) throw notFound('Open slot');
    await cache.bump(`slots:${doctorId}`);
    await auditService.record({ ...ctx, action: 'slots.block', resourceType: 'slot', resourceId: slotId });
    return toDto(row);
  }

  return { createSlots, listOpen, listMine, block };
}

module.exports = { createAvailabilityService };
