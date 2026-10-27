CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- creates <parent>_YYYY_MM partition for the month containing month_start
CREATE OR REPLACE FUNCTION create_monthly_partition(parent text, month_start date) RETURNS void AS $$
DECLARE
  m date := date_trunc('month', month_start)::date;
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
    parent || '_' || to_char(m, 'YYYY_MM'), parent, m, (m + interval '1 month')::date
  );
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- users

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('patient', 'doctor', 'admin')),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  mfa_enabled    boolean NOT NULL DEFAULT false,
  mfa_secret_enc text,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE profiles (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name     text NOT NULL,
  phone_enc     text,
  date_of_birth date,
  gender        text CHECK (gender IN ('male', 'female', 'other')),
  city          text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_profiles_name_trgm ON profiles USING gin (full_name gin_trgm_ops);
CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  family_id   uuid NOT NULL,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_tokens_family ON refresh_tokens (family_id);

-- ---------------------------------------------------------------- doctors

CREATE TABLE doctors (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  registration_no  text NOT NULL UNIQUE,
  specialization   text NOT NULL,
  languages        text[] NOT NULL DEFAULT '{}',
  experience_years int NOT NULL DEFAULT 0 CHECK (experience_years >= 0),
  fee_paise        int NOT NULL CHECK (fee_paise >= 0),
  bio              text,
  rating_avg       numeric(2, 1) NOT NULL DEFAULT 0,
  rating_count     int NOT NULL DEFAULT 0,
  is_verified      boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_doctors_spec_fee ON doctors (specialization, fee_paise) WHERE is_verified;
CREATE INDEX idx_doctors_languages ON doctors USING gin (languages);
CREATE TRIGGER trg_doctors_updated BEFORE UPDATE ON doctors FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE availability_slots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id   uuid NOT NULL REFERENCES doctors(user_id) ON DELETE CASCADE,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'held', 'booked', 'blocked')),
  held_until  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  -- a doctor can't have two overlapping slots
  EXCLUDE USING gist (doctor_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
);
CREATE INDEX idx_slots_open ON availability_slots (doctor_id, starts_at) WHERE status = 'open';
CREATE INDEX idx_slots_held ON availability_slots (held_until) WHERE status = 'held';
CREATE TRIGGER trg_slots_updated BEFORE UPDATE ON availability_slots FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- consultations
-- range partitioned by month on scheduled_at. ~100k/day => ~3M rows/month,
-- old months can be detached + archived without touching hot data.

CREATE TABLE consultations (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  scheduled_at     timestamptz NOT NULL,
  patient_id       uuid NOT NULL REFERENCES users(id),
  doctor_id        uuid NOT NULL REFERENCES doctors(user_id),
  slot_id          uuid NOT NULL REFERENCES availability_slots(id),
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show')),
  reason_enc       text,
  doctor_notes_enc text,
  meeting_url      text,
  cancel_reason    text,
  cancelled_by     uuid,
  started_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, scheduled_at)
) PARTITION BY RANGE (scheduled_at);

-- last line of defence against double booking, even if redis lock is lost
CREATE UNIQUE INDEX uq_consultations_active_slot ON consultations (slot_id, scheduled_at)
  WHERE status IN ('pending', 'confirmed', 'in_progress');
CREATE INDEX idx_consultations_patient ON consultations (patient_id, scheduled_at DESC);
CREATE INDEX idx_consultations_doctor ON consultations (doctor_id, scheduled_at DESC);
CREATE TRIGGER trg_consultations_updated BEFORE UPDATE ON consultations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE prescriptions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id           uuid NOT NULL,
  consultation_scheduled_at timestamptz NOT NULL,
  doctor_id                 uuid NOT NULL REFERENCES doctors(user_id),
  patient_id                uuid NOT NULL REFERENCES users(id),
  medications_enc           text NOT NULL,
  advice_enc                text,
  pdf_path                  text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (consultation_id, consultation_scheduled_at) REFERENCES consultations (id, scheduled_at),
  UNIQUE (consultation_id)
);
CREATE INDEX idx_prescriptions_patient ON prescriptions (patient_id, created_at DESC);

CREATE TABLE payments (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id           uuid NOT NULL,
  consultation_scheduled_at timestamptz NOT NULL,
  patient_id                uuid NOT NULL REFERENCES users(id),
  amount_paise              int NOT NULL CHECK (amount_paise >= 0),
  currency                  text NOT NULL DEFAULT 'INR',
  status                    text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'succeeded', 'failed', 'refunded')),
  provider                  text NOT NULL DEFAULT 'mockpay',
  provider_ref              text UNIQUE,
  failure_reason            text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (consultation_id, consultation_scheduled_at) REFERENCES consultations (id, scheduled_at)
);
CREATE INDEX idx_payments_consultation ON payments (consultation_id);
CREATE INDEX idx_payments_created ON payments (created_at);
CREATE TRIGGER trg_payments_updated BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- audit
-- append only. partitioned by month so retention = drop old partitions.

CREATE TABLE audit_logs (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  actor_id      uuid,
  actor_role    text,
  action        text NOT NULL,
  resource_type text NOT NULL,
  resource_id   text,
  ip            inet,
  user_agent    text,
  request_id    text,
  metadata      jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX idx_audit_actor ON audit_logs (actor_id, created_at DESC);
CREATE INDEX idx_audit_resource ON audit_logs (resource_type, resource_id);

CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

-- partitions: previous month + next 12. a daily job keeps creating months ahead.
DO $$
DECLARE
  m date;
BEGIN
  FOR m IN SELECT generate_series(date_trunc('month', now()) - interval '1 month',
                                  date_trunc('month', now()) + interval '12 months',
                                  interval '1 month')::date
  LOOP
    PERFORM create_monthly_partition('consultations', m);
    PERFORM create_monthly_partition('audit_logs', m);
  END LOOP;
END $$;
