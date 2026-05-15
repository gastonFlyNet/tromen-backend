-- ============================================================
--  TROMEN — Schema v1.0.0
--  BYF Soluciones · PostgreSQL 14+
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
--  ENUMS
-- ============================================================

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'supervisor', 'repartidor');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE route_status AS ENUM ('pendiente', 'en_curso', 'completada', 'cancelada');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE delivery_status AS ENUM ('pendiente', 'entregado', 'no_entregado', 'parcial', 'devuelto');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_method AS ENUM ('efectivo', 'transferencia', 'cuenta_corriente', 'mixto');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('pendiente', 'confirmado', 'rechazado', 'conciliado');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE evidence_type AS ENUM ('foto_entrega', 'firma_digital', 'foto_rechazo', 'comprobante');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE geofence_type AS ENUM ('zona_entrega', 'zona_restringida', 'deposito', 'cliente');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE geofence_event_type AS ENUM ('entrada', 'salida');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE closing_status AS ENUM ('borrador', 'confirmado', 'con_diferencia', 'auditado');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
--  FUNCIÓN updated_at automático
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
--  TABLA: users
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(120)  NOT NULL,
  email         VARCHAR(255)  NOT NULL UNIQUE,
  phone         VARCHAR(30),
  password_hash VARCHAR(255)  NOT NULL,
  role          user_role     NOT NULL DEFAULT 'repartidor',
  active        BOOLEAN       NOT NULL DEFAULT true,
  avatar_url    TEXT,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
--  TABLA: clients
-- ============================================================

CREATE TABLE IF NOT EXISTS clients (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(200)  NOT NULL,
  trade_name    VARCHAR(200),
  address       TEXT          NOT NULL,
  city          VARCHAR(100),
  zone          VARCHAR(80),
  phone         VARCHAR(30),
  email         VARCHAR(255),
  tax_id        VARCHAR(30)   UNIQUE,
  credit_limit  NUMERIC(12,2) NOT NULL DEFAULT 0,
  balance       NUMERIC(12,2) NOT NULL DEFAULT 0,
  latitude      NUMERIC(10,7),
  longitude     NUMERIC(10,7),
  active        BOOLEAN       NOT NULL DEFAULT true,
  notes         TEXT,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_clients_updated_at ON clients;
CREATE TRIGGER trg_clients_updated_at
  BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
--  TABLA: routes
-- ============================================================

CREATE TABLE IF NOT EXISTS routes (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  route_date       DATE          NOT NULL,
  status           route_status  NOT NULL DEFAULT 'pendiente',
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  total_stops      INTEGER       NOT NULL DEFAULT 0,
  completed_stops  INTEGER       NOT NULL DEFAULT 0,
  total_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  collected_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  vehicle_id       VARCHAR(50),
  notes            TEXT,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_route_user_date UNIQUE (user_id, route_date)
);

DROP TRIGGER IF EXISTS trg_routes_updated_at ON routes;
CREATE TRIGGER trg_routes_updated_at
  BEFORE UPDATE ON routes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
--  TABLA: deliveries
-- ============================================================

CREATE TABLE IF NOT EXISTS deliveries (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  route_id           UUID            NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  client_id          UUID            NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  stop_order         INTEGER         NOT NULL DEFAULT 0,
  status             delivery_status NOT NULL DEFAULT 'pendiente',
  expected_amount    NUMERIC(12,2)   NOT NULL DEFAULT 0,
  actual_amount      NUMERIC(12,2)   NOT NULL DEFAULT 0,
  payment_method     payment_method,
  cash_received      NUMERIC(12,2)   NOT NULL DEFAULT 0,
  transfer_amount    NUMERIC(12,2)   NOT NULL DEFAULT 0,
  credit_amount      NUMERIC(12,2)   NOT NULL DEFAULT 0,
  change_given       NUMERIC(12,2)   NOT NULL DEFAULT 0,
  delivery_latitude  NUMERIC(10,7),
  delivery_longitude NUMERIC(10,7),
  arrived_at         TIMESTAMPTZ,
  delivered_at       TIMESTAMPTZ,
  rejection_reason   TEXT,
  notes              TEXT,
  created_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_deliveries_updated_at ON deliveries;
CREATE TRIGGER trg_deliveries_updated_at
  BEFORE UPDATE ON deliveries FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
--  TABLA: delivery_evidence
-- ============================================================

CREATE TABLE IF NOT EXISTS delivery_evidence (
  id           UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  delivery_id  UUID          NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  type         evidence_type NOT NULL,
  file_url     TEXT          NOT NULL,
  file_size_kb INTEGER,
  latitude     NUMERIC(10,7),
  longitude    NUMERIC(10,7),
  captured_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ============================================================
--  TABLA: payments
-- ============================================================

CREATE TABLE IF NOT EXISTS payments (
  id               UUID           PRIMARY KEY DEFAULT uuid_generate_v4(),
  delivery_id      UUID           NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  client_id        UUID           NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  method           payment_method NOT NULL,
  amount           NUMERIC(12,2)  NOT NULL,
  reference        VARCHAR(100),
  status           payment_status NOT NULL DEFAULT 'pendiente',
  reconciled_at    TIMESTAMPTZ,
  reconciled_by_id UUID REFERENCES users(id),
  notes            TEXT,
  created_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_payments_updated_at ON payments;
CREATE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
--  TABLA: cash_closings
-- ============================================================

CREATE TABLE IF NOT EXISTS cash_closings (
  id              UUID           PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID           NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  route_id        UUID           REFERENCES routes(id),
  closing_date    DATE           NOT NULL,
  cash_declared   NUMERIC(12,2)  NOT NULL DEFAULT 0,
  cash_system     NUMERIC(12,2)  NOT NULL DEFAULT 0,
  transfers_total NUMERIC(12,2)  NOT NULL DEFAULT 0,
  credit_total    NUMERIC(12,2)  NOT NULL DEFAULT 0,
  status          closing_status NOT NULL DEFAULT 'borrador',
  reviewed_by_id  UUID REFERENCES users(id),
  reviewed_at     TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_closing_user_date UNIQUE (user_id, closing_date)
);

DROP TRIGGER IF EXISTS trg_cash_closings_updated_at ON cash_closings;
CREATE TRIGGER trg_cash_closings_updated_at
  BEFORE UPDATE ON cash_closings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
--  TABLA: gps_events
-- ============================================================

CREATE TABLE IF NOT EXISTS gps_events (
  id          UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id    UUID          REFERENCES routes(id) ON DELETE SET NULL,
  latitude    NUMERIC(10,7) NOT NULL,
  longitude   NUMERIC(10,7) NOT NULL,
  altitude    NUMERIC(8,2),
  accuracy    NUMERIC(6,2),
  speed       NUMERIC(6,2),
  heading     NUMERIC(5,2),
  device_id   VARCHAR(100),
  battery_pct SMALLINT,
  recorded_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ============================================================
--  TABLA: geofences
-- ============================================================

CREATE TABLE IF NOT EXISTS geofences (
  id             UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  name           VARCHAR(150)  NOT NULL,
  description    TEXT,
  type           geofence_type NOT NULL DEFAULT 'zona_entrega',
  polygon_coords JSONB         NOT NULL,
  center_lat     NUMERIC(10,7),
  center_lon     NUMERIC(10,7),
  radius_meters  INTEGER,
  active         BOOLEAN       NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_geofences_updated_at ON geofences;
CREATE TRIGGER trg_geofences_updated_at
  BEFORE UPDATE ON geofences FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
--  TABLA: geofence_events
-- ============================================================

CREATE TABLE IF NOT EXISTS geofence_events (
  id           UUID                PRIMARY KEY DEFAULT uuid_generate_v4(),
  geofence_id  UUID                NOT NULL REFERENCES geofences(id) ON DELETE CASCADE,
  user_id      UUID                NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id     UUID                REFERENCES routes(id),
  event_type   geofence_event_type NOT NULL,
  latitude     NUMERIC(10,7)       NOT NULL,
  longitude    NUMERIC(10,7)       NOT NULL,
  occurred_at  TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);

-- ============================================================
--  ÍNDICES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_users_role        ON users(role) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_clients_zone      ON clients(zone) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_routes_user_date  ON routes(user_id, route_date DESC);
CREATE INDEX IF NOT EXISTS idx_routes_status     ON routes(status);
CREATE INDEX IF NOT EXISTS idx_routes_date       ON routes(route_date DESC);
CREATE INDEX IF NOT EXISTS idx_deliveries_route  ON deliveries(route_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_client ON deliveries(client_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status);
CREATE INDEX IF NOT EXISTS idx_gps_user_time     ON gps_events(user_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_gps_route_time    ON gps_events(route_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_client   ON payments(client_id);
CREATE INDEX IF NOT EXISTS idx_payments_status   ON payments(status);
CREATE INDEX IF NOT EXISTS idx_closing_user_date ON cash_closings(user_id, closing_date DESC);
CREATE INDEX IF NOT EXISTS idx_gfe_user_time     ON geofence_events(user_id, occurred_at DESC);

-- ============================================================
--  VISTAS
-- ============================================================

CREATE OR REPLACE VIEW v_daily_summary AS
SELECT
  r.id                                                          AS route_id,
  r.route_date,
  u.id                                                          AS user_id,
  u.name                                                        AS repartidor,
  r.status                                                      AS route_status,
  r.total_stops,
  r.completed_stops,
  COUNT(d.id)                                                   AS total_deliveries,
  COUNT(d.id) FILTER (WHERE d.status = 'entregado')             AS delivered,
  COUNT(d.id) FILTER (WHERE d.status = 'no_entregado')          AS not_delivered,
  COALESCE(SUM(d.actual_amount), 0)                             AS total_collected,
  COALESCE(SUM(d.cash_received), 0)                             AS cash_total,
  COALESCE(SUM(d.transfer_amount), 0)                           AS transfer_total,
  COALESCE(SUM(d.credit_amount), 0)                             AS credit_total
FROM routes r
JOIN users u ON u.id = r.user_id
LEFT JOIN deliveries d ON d.route_id = r.id
GROUP BY r.id, r.route_date, u.id, u.name, r.status, r.total_stops, r.completed_stops;

CREATE OR REPLACE VIEW v_client_balances AS
SELECT
  c.id,
  c.name,
  c.zone,
  c.credit_limit,
  c.balance                          AS current_balance,
  c.credit_limit - c.balance         AS available_credit,
  COUNT(d.id) FILTER (WHERE d.status = 'entregado') AS total_deliveries,
  MAX(d.delivered_at)                AS last_delivery_at
FROM clients c
LEFT JOIN deliveries d ON d.client_id = c.id
WHERE c.active = true
GROUP BY c.id, c.name, c.zone, c.credit_limit, c.balance;

CREATE OR REPLACE VIEW v_last_known_position AS
SELECT DISTINCT ON (g.user_id)
  g.user_id,
  u.name      AS repartidor,
  g.latitude,
  g.longitude,
  g.speed,
  g.recorded_at,
  r.id        AS route_id,
  r.status    AS route_status
FROM gps_events g
JOIN users u ON u.id = g.user_id
LEFT JOIN routes r ON r.id = g.route_id
WHERE g.recorded_at > NOW() - INTERVAL '12 hours'
ORDER BY g.user_id, g.recorded_at DESC;
