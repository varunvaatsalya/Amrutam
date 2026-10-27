# Amrutam Telemedicine API

Backend for doctor discovery, slot booking, consultations and prescriptions.
Node.js (Express 5) + PostgreSQL + Redis.

> Work in progress - auth, schema and infra are in. Booking/consultation flows next.

## Running locally

Needs Node 20+ and Docker.

```bash
cp .env.example .env          # then fill JWT_ACCESS_SECRET and ENCRYPTION_KEYS (commands are in the file)
docker compose up -d postgres redis
npm install
npm run migrate
npm run dev                   # http://localhost:3000
```

Or run everything in containers: `docker compose up --build`.

Tests: `npm test`

## What's there so far

- `POST /api/v1/auth/register` - patient or doctor (doctors start unverified)
- `POST /api/v1/auth/login` - lockout after 5 failed attempts for 15 min
- `POST /api/v1/auth/refresh` - refresh token rotation, reuse of an old token revokes the whole session family
- `POST /api/v1/auth/logout`
- `GET  /api/v1/auth/me`
- `GET /health`, `GET /ready`

## Layout

```
src/
  modules/<feature>/   routes -> service -> repo
  middleware/          auth, validation, rate limit, errors
  lib/                 db, redis, logger, field encryption
  container.js         wires dependencies (manual DI)
migrations/            plain SQL, run by scripts/migrate.js
```
