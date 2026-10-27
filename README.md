# Amrutam Telemedicine API

Backend for Amrutam's doctor consultations: search doctors, book a slot, pay,
run the consultation, issue a prescription. Includes admin analytics and a compliance
audit trail.

Node.js 22 (Express 5) · PostgreSQL 16 · Redis 7 (cache, rate limits, idempotency, BullMQ jobs)

- [docs/architecture.md](docs/architecture.md): design, diagrams (HLD, booking sequence, ER), retries, partitioning, caching, sagas, DR
- [docs/security.md](docs/security.md): data classification, OWASP mapping, threat model, key rotation, checklist
- [docs/openapi.yaml](docs/openapi.yaml): API spec (also served at `GET /openapi.yaml`)

## Quick start

Needs Node 20+ and Docker.

```bash
cp .env.example .env
# fill JWT_ACCESS_SECRET, ENCRYPTION_KEYS, PAYMENT_WEBHOOK_SECRET (generator commands are in the file)

docker compose up -d postgres redis
npm install
npm run migrate
npm run seed          # demo accounts, prints the admin TOTP secret

npm run dev           # API on :3000
npm run dev:worker    # background jobs (second terminal)
```

Everything in containers instead: `docker compose up --build`
(add `--profile observability` for Prometheus on :9090 and Grafana on :3001).

### Tests

```bash
npm test                  # unit: crypto, TOTP (RFC 6238 vectors), state machine
npm run test:integration  # against the running postgres + redis: booking races, idempotency,
                          # saga compensation, refresh-token reuse, MFA, RBAC/IDOR, audit immutability
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs both against service
containers, then `npm audit`, builds the image and scans it with Trivy.

## Seeded accounts

Password for all: `Password123`

| Email | Role |
|---|---|
| `patient@amrutam.local` | patient |
| `dr.sharma@amrutam.local`, `dr.iyer@amrutam.local`, `dr.khan@amrutam.local` | doctors (verified, slots 10:00-13:00 IST for the next 3 days) |
| `admin@amrutam.local` | admin, MFA on. Current code: `node scripts/totp.js <secret printed by seed>` |

## Demo walkthrough

```bash
B=http://localhost:3000/api/v1

# 1. find a doctor and an open slot
curl "$B/doctors?language=hindi&sort=fee"
curl "$B/doctors/<doctorId>/slots"

# 2. patient logs in and books (Idempotency-Key is mandatory)
TOKEN=$(curl -s -X POST $B/auth/login -H 'content-type: application/json' \
  -d '{"email":"patient@amrutam.local","password":"Password123"}' | jq -r .accessToken)
curl -X POST $B/bookings -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'idempotency-key: demo-booking-001' -d '{"slotId":"<slotId>","reason":"joint pain"}'
#    run it again with the same key -> same response, header Idempotent-Replayed: true
#    same key, different slotId -> 422

# 3. pay (mock gateway -> signed webhook -> consultation confirmed)
curl -X POST $B/payments/<paymentId>/mock-pay -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H 'idempotency-key: demo-pay-001' -d '{"outcome":"success"}'

# 4. doctor: start -> prescription (needs MFA login) -> complete
#    POST /auth/mfa/setup, /auth/mfa/enable, log in again with mfaCode
#    POST /consultations/<id>/start | /prescription | /complete

# 5. patient downloads the PDF the worker rendered
curl -o rx.pdf $B/prescriptions/<prescriptionId>/pdf -H "authorization: Bearer $TOKEN"

# 6. admin
#    GET /admin/analytics/summary, /admin/analytics/live, /admin/audit-logs?action=consultation.read
```

## What's implemented

| Area | Notes |
|---|---|
| Auth & users | register (patient/doctor), login with lockout, refresh rotation with reuse detection, logout, TOTP MFA (mandatory for staff on PHI writes/admin), profile update, admin suspend |
| Doctors & availability | search (text, specialization, language, city, fee, rating, available date) with keyset pagination + cache, slot creation (explicit or generated), overlap protection, blocking |
| Booking | saga: hold -> pay -> confirm, with compensation for failure, expiry and late payment. Redis lock + row lock + unique index against double booking. |
| Payments | mock gateway, HMAC-signed idempotent webhook, refunds as background jobs |
| Consultations | state machine (pending/confirmed/in_progress/completed/cancelled/no_show), cancel policy with refunds |
| Prescriptions | encrypted at rest, PDF rendered by the worker, download for participants |
| Compliance | append-only, partitioned audit log, PHI reads logged, admin search |
| Analytics | materialized daily rollup refreshed every 15 min + live view for today |
| Platform | idempotency middleware, rate limiting, Zod validation, field encryption with key rotation, structured logs, Prometheus metrics, trace id propagation, graceful shutdown, health/readiness probes, Docker, k8s manifests ([infra/k8s](infra/k8s)) |

## Measured latency

`node scripts/loadtest.js` on a laptop (API + Postgres + Redis in Docker, 20 concurrent clients):

| Endpoint | p50 | p95 | p99 |
|---|---|---|---|
| `GET /doctors` (search) | 13ms | 21ms | 28ms |
| `GET /doctors/:id/slots` | 13ms | 23ms | 41ms |
| `POST /bookings` | 63ms | 139ms | 159ms |

Targets are p95 < 200ms reads and < 500ms writes. These are single-machine numbers
with seeded data, so they say more about the code path than about production capacity.

## Project layout

```
src/
  modules/<domain>/    routes -> service -> repo, one folder per domain
  middleware/          auth/RBAC/MFA, validation, idempotency, rate limit, request context, errors
  lib/                 db, redis, cache, lock, queue, crypto, totp, metrics, logger
  jobs/processors.js   background job handlers + schedules
  container.js         manual dependency injection
  server.js / worker.js
migrations/            plain SQL (001 schema + partitions, 002 analytics view)
scripts/               migrate, seed, rotate-keys, loadtest, totp
infra/                 k8s manifests, prometheus config + alerts, grafana dashboard
tests/unit, tests/integration
```

## Decisions and trade-offs

- **No ORM.** Partitioning, exclusion constraints, `FOR UPDATE` and partial unique
  indexes are the core of this system. Plain SQL keeps them visible.
- **One Redis for four roles.** Simple to run at this scale. Split cache from
  queue/idempotency if eviction ever becomes a concern.
- **Idempotency in Redis, correctness in Postgres.** Keys live 24h in Redis. If Redis
  loses them, the DB constraints still prevent double bookings/charges. If Redis is
  down, idempotent writes return 503 instead of guessing.
- **Rate limiter fails open, idempotency fails closed.** Refusing all traffic when
  Redis blips would be worse than briefly losing rate limits. Double charging is never
  acceptable.
- **Payments are mocked.** The webhook shape and signing match what Razorpay/Stripe
  do, so swapping in a real client is contained to `payments.service.js`.
- **Hand-written DI.** About 40 lines in `container.js`, no container library.

## Not done / next

- Real payment gateway integration and a circuit breaker around it
- PDFs on S3 with pre-signed URLs (local disk only works when API and worker share a volume)
- OpenTelemetry spans (trace ids are already propagated in W3C format)
- Ratings/reviews write path, notification delivery (email/SMS are stubs that log)
- Cap on concurrent pending holds per patient
