# Security and threat model

Health data is the most sensitive thing we hold, so the default is to collect little,
encrypt what we keep, log who touched it, and fail closed on anything involving money.

## 1. Data classification

| Class | Examples | Handling |
|---|---|---|
| **PHI** (restricted) | consultation reason, doctor notes, prescriptions, prescription PDFs | AES-256-GCM field encryption at rest. Only shown to participants/admin. Every read is audit-logged. Never in logs or job payloads. |
| **PII** (confidential) | phone, DOB, name, MFA secret | phone and MFA secret field-encrypted. Name/city stay plain because search needs them. DOB is plain too (low value alone, but an easy next candidate for encryption). All of it sits behind DB access controls + disk encryption. |
| **Credentials** | passwords, refresh tokens, TOTP secrets | bcrypt (cost 11) for passwords, SHA-256 hashes for refresh tokens (raw token never stored), TOTP secret encrypted |
| **Internal** | audit logs, metrics, payment refs | access limited to admin role / ops |
| **Public** | verified doctor profiles, open slots | cacheable, no auth |

## 2. Attack surface

| Entry point | Exposure | Controls |
|---|---|---|
| `/api/v1/auth/*` | internet | IP rate limit (10/min), account lockout after 5 failures, constant-time compare with a dummy hash for unknown emails (no user enumeration by timing), generic error messages |
| Authenticated API | internet | JWT (HS256, 15 min, issuer + algorithm pinned), RBAC per route, ownership checks in services (404 for non-participants), Zod validation on every body/query/param, 100kb body limit |
| `/payments/webhook` | internet (gateway) | HMAC-SHA256 over raw body, timing-safe compare, state-based idempotency |
| `/metrics` | cluster only | not routed through the public ingress, optional bearer token |
| Postgres / Redis | private subnet | no public IP, TLS in transit, separate creds per service, app role without DDL in prod |
| Worker | none (no inbound except metrics) | same image, same secrets, least privilege |
| CI/CD | GitHub | dependency audit + image scan on every PR, secrets only in GitHub/secret manager |

## 3. OWASP Top 10 (2021) mapping

| Risk | What we do |
|---|---|
| A01 Broken access control | `requireRole` on every route group. Services check ownership (patient_id/doctor_id), not just role. Non-participants get 404 so ids can't be probed. Admin and prescription writes require an MFA-backed token. Idempotency keys are scoped per user so one user can't replay another's response. |
| A02 Cryptographic failures | AES-256-GCM with random 96-bit IV and auth tag per field. bcrypt for passwords. TLS terminated at the LB; DB/Redis TLS is set through the prod connection strings (see checklist). Keys only from env/secret manager. |
| A03 Injection | 100% parameterised SQL (`$1` placeholders). Dynamic SQL only ever interpolates column names from hardcoded allow-lists (sort keys, update maps). Zod rejects unexpected types before they reach a query. |
| A04 Insecure design | Booking invariants enforced in the DB (exclusion constraint, partial unique index), not only in code. Explicit state machine. Fail closed when idempotency storage is down. |
| A05 Security misconfiguration | helmet headers, `x-powered-by` off, config validated at boot (refuses to start with missing/short secrets), non-root container, read-only root FS + dropped capabilities in k8s. |
| A06 Vulnerable components | `npm audit --audit-level=high` and Trivy image scan in CI, both blocking. Small dependency tree on purpose (11 runtime deps, no ORM/framework stack). Dependabot recommended on the repo. |
| A07 Identification & auth failures | lockout, rate limits, MFA (TOTP with replay protection), refresh token rotation with reuse detection (a reused token revokes the whole session family), short-lived access tokens, suspension revokes refresh tokens. |
| A08 Software & data integrity | signed webhooks, lockfile + `npm ci`, image built in CI from a pinned base. |
| A09 Logging & monitoring failures | append-only audit log for auth events, PHI reads/writes, admin actions and payments. Structured logs with request/trace ids. Alerts on error rate, latency, job failures. |
| A10 SSRF | the server makes no outbound requests based on user input. The meeting URL is generated, not user supplied. |

## 4. Encryption and key rotation

- Format: `<keyId>.<iv>.<tag>.<ciphertext>` (`src/lib/crypto.js`). The key id travels
  with every value, so several keys can be live at once.
- Keys: `ENCRYPTION_KEYS=k1:<b64>,k2:<b64>`, `ENCRYPTION_ACTIVE_KEY=k2`. In production
  these come from KMS / a secret manager via external-secrets. Better still is
  envelope encryption, where KMS wraps a data key.
- **Rotation runbook:**
  1. Generate a new 32-byte key, add it to `ENCRYPTION_KEYS`, set it active, deploy.
     New writes use it, and old rows still decrypt.
  2. `npm run rotate-keys` re-encrypts old rows in batches. It's idempotent and can
     be resumed.
  3. When it reports 0 rows, remove the old key and deploy.
  4. Rotate yearly, or right away if a key may have leaked.
- JWT secret rotation: deploy with the new secret. Access tokens live 15 min, so the
  impact is everyone re-authenticating via refresh. Supporting two verify keys
  (kid header) would make it seamless and is a small change.
- Webhook secret: rotate on the gateway and here together. The gateway usually allows
  two active secrets during the switch.

## 5. Audit trail

`audit_logs` rows carry actor, role, action, resource, IP, user agent, request id and
small metadata (never PHI values). It's append-only: a trigger rejects UPDATE/DELETE,
and in prod the app role also lacks those grants. Partitioned monthly, so retention
means detaching and archiving old partitions to WORM storage.

Logged actions: register, login, failed login, refresh-token reuse, logout, MFA
enable, profile/doctor updates, slot changes, booking create/expire, payment
success/fail/refund, consultation read/transition/cancel, prescription
create/read/download, doctor verification, user suspension.

Admins search it via `GET /admin/audit-logs`.

## 6. Threat model (STRIDE)

| Threat | Scenario | Mitigation | Residual risk |
|---|---|---|---|
| **S**poofing | stolen password | lockout, rate limit, MFA mandatory for staff | patients without MFA are exposed to credential stuffing. Breached-password check would help. |
| Spoofing | forged payment webhook confirming unpaid bookings | HMAC signature over raw body | secret leak -> rotate |
| Spoofing | forged JWT (`alg: none`, role escalation) | algorithm pinned to HS256, issuer checked, signature verified (tested) | |
| **T**ampering | patient changes `amount` or `doctorId` in booking | price and doctor come from the slot row server side, the body only carries `slotId` | |
| Tampering | editing audit history to hide access | trigger + grants, partitions archived to WORM | a DB superuser can still do it, so superuser access is break-glass only |
| **R**epudiation | doctor denies writing a prescription | audit row with actor, request id, IP. MFA-backed session. | |
| **I**nformation disclosure | IDOR: patient reads another patient's consultation | ownership check, 404 not 403, uuids not sequential ids (tested) | |
| Information disclosure | DB dump / backup leak | PHI is ciphertext, keys live outside the DB | DOB/name are plain |
| Information disclosure | PHI in logs or queues | logger redaction, jobs carry ids only, list endpoints omit PHI | developer adding a careless log line, so log review belongs in PR checklist |
| **D**oS | login/search flooding | per-IP/user rate limits in Redis, body size limit, statement timeout, WAF in front | the limiter fails open if Redis is down (deliberate, availability first) |
| DoS | bot holding all slots without paying | holds expire in 10 min, per-user rate limit | add a cap on concurrent pending holds per patient |
| **E**levation of privilege | patient self-registers as admin | `role` only accepts patient/doctor. Admins are created out of band (seed / ops). | |
| Elevation | doctor acts on another doctor's consultation | doctor_id ownership in every transition (tested) | |

## 7. Security checklist

- [x] Secrets only via env vars, validated at startup, `.env` git-ignored
- [x] Passwords bcrypt-hashed, refresh tokens stored hashed
- [x] MFA (TOTP) for doctors and admins, enforced on PHI writes and admin APIs
- [x] RBAC + resource ownership checks
- [x] Input validation on every endpoint (Zod), body size limit
- [x] Parameterised SQL only
- [x] Field-level encryption for PHI/PII, with key rotation script
- [x] Rate limiting (global + auth) and login lockout
- [x] Idempotency keys on booking/payment/cancel/prescription writes
- [x] Signed, idempotent payment webhooks
- [x] Append-only audit log, PHI reads logged
- [x] Security headers (helmet), no stack traces in responses
- [x] Non-root container, read-only FS, dropped capabilities
- [x] `npm audit` + Trivy in CI
- [ ] TLS to Postgres/Redis (infra config, `sslmode=require` in prod DATABASE_URL)
- [ ] WAF rules at the load balancer
- [ ] Breached-password check on register (k-anonymity API)
- [ ] Penetration test before go-live
- [ ] DPDP Act (India) data-subject export/delete flows
