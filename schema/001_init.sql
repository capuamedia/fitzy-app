-- Fitzy Mobile Fueling — initial schema
--
-- Money is stored in CENTS as INTEGER throughout. Never floats: $69.99 is 6999.
-- Timestamps are ISO-8601 UTC strings. Dates are 'YYYY-MM-DD' local to the
-- service area (America/Los_Angeles) — a delivery date is a calendar day in
-- Justin's world, not an instant.

PRAGMA foreign_keys = ON;

-- ===========================================================================
-- CONFIG
-- Nothing about pricing, hours or capacity is hardcoded in application code.
-- All of it lives here so it changes without a deploy.
-- ===========================================================================

-- Single-row-per-key settings. Values are TEXT; callers parse.
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Service zones. The delivery address resolves to a zip, the zip resolves to
-- a zone, and the zone carries both the plan price and the per-visit fee.
CREATE TABLE zones (
  id                 INTEGER PRIMARY KEY,
  slug               TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  monthly_price_cents INTEGER NOT NULL,
  per_visit_cents    INTEGER NOT NULL,
  active             INTEGER NOT NULL DEFAULT 1,
  sort_order         INTEGER NOT NULL DEFAULT 0
);

-- Zips map many-to-one onto zones. Simi Valley splits across two zones, which
-- is exactly why this is a table and not a list of city names.
CREATE TABLE zone_zips (
  zip     TEXT PRIMARY KEY,
  zone_id INTEGER NOT NULL REFERENCES zones(id)
);

-- Plans. The standard plan's price comes from the member's zone; VIP is a
-- flat price across all zones. price_cents is NULL when the zone decides.
CREATE TABLE plans (
  id                  INTEGER PRIMARY KEY,
  slug                TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  price_cents         INTEGER,
  visits_included     INTEGER NOT NULL,
  includes_tire_check INTEGER NOT NULL DEFAULT 0,
  includes_window_wash INTEGER NOT NULL DEFAULT 0,
  active              INTEGER NOT NULL DEFAULT 1,
  sort_order          INTEGER NOT NULL DEFAULT 0
);

-- Service hours, one row per weekday per window block. dow: 0=Sunday.
-- A day with no rows is closed. Two rows for one day = a split shift.
CREATE TABLE service_hours (
  id         INTEGER PRIMARY KEY,
  dow        INTEGER NOT NULL CHECK (dow BETWEEN 0 AND 6),
  opens_at   TEXT NOT NULL,   -- 'HH:MM' local
  closes_at  TEXT NOT NULL,   -- 'HH:MM' local
  active     INTEGER NOT NULL DEFAULT 1
);

-- Dates Fitzy is closed regardless of service_hours.
CREATE TABLE blackout_dates (
  date   TEXT PRIMARY KEY,    -- 'YYYY-MM-DD'
  reason TEXT
);

-- ===========================================================================
-- PEOPLE AND THEIR THINGS
-- ===========================================================================

CREATE TABLE users (
  id                    TEXT PRIMARY KEY,
  first_name            TEXT NOT NULL,
  last_name             TEXT NOT NULL,
  phone                 TEXT NOT NULL UNIQUE,
  email                 TEXT,
  -- TCPA: service and marketing consent are tracked separately and neither
  -- defaults to on. See docs/business-rules.md.
  sms_service_consent   INTEGER NOT NULL DEFAULT 0,
  sms_marketing_consent INTEGER NOT NULL DEFAULT 0,
  sms_consent_at        TEXT,
  is_owner              INTEGER NOT NULL DEFAULT 0,   -- ops dashboard access
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at            TEXT
);

-- Which version of the liability waiver each customer actually signed.
-- Version matters: if the waiver is amended, existing customers must
-- re-accept, and the record has to say which text they agreed to.
CREATE TABLE waiver_acceptances (
  id            INTEGER PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  document      TEXT NOT NULL,          -- 'liability_waiver' | 'terms_of_service'
  version       TEXT NOT NULL,          -- '1.0'
  typed_name    TEXT NOT NULL,
  accepted_at   TEXT NOT NULL DEFAULT (datetime('now')),
  ip_address    TEXT,
  user_agent    TEXT
);
CREATE INDEX idx_waiver_user ON waiver_acceptances(user_id, document);

CREATE TABLE vehicles (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  year          INTEGER,
  make          TEXT NOT NULL,
  model         TEXT NOT NULL,
  color         TEXT,
  plate         TEXT,
  fuel_grade    TEXT NOT NULL CHECK (fuel_grade IN ('87','91','diesel')),
  tank_gallons  REAL,
  vehicle_class TEXT NOT NULL DEFAULT 'standard'
                CHECK (vehicle_class IN ('standard','large','motorhome')),
  is_default    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at    TEXT
);
CREATE INDEX idx_vehicles_user ON vehicles(user_id) WHERE deleted_at IS NULL;

-- Addresses are geocoded ONCE at save time. The resolved zip and coordinates
-- are stored, so booking never calls the Maps API and the zone price is
-- deterministic and auditable.
CREATE TABLE locations (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  label          TEXT NOT NULL,
  address_line1  TEXT NOT NULL,
  address_line2  TEXT,
  city           TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'CA',
  zip            TEXT NOT NULL,
  lat            REAL,
  lng            REAL,
  pin_lat        REAL,                  -- customer-adjusted delivery pin
  pin_lng        REAL,
  gate_code      TEXT,
  parking_notes  TEXT,
  zone_id        INTEGER REFERENCES zones(id),   -- NULL = outside service area
  geocoded_at    TEXT,
  is_default     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at     TEXT
);
CREATE INDEX idx_locations_user ON locations(user_id) WHERE deleted_at IS NULL;

-- ===========================================================================
-- MEMBERSHIP
-- A membership is counted in VISITS, not vehicles. One visit = one trip to
-- one location at one time, covering up to `included_vehicles` vehicles.
-- ===========================================================================

CREATE TABLE memberships (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES users(id),
  plan_id                INTEGER NOT NULL REFERENCES plans(id),
  -- The zone the plan was priced from, captured at signup. Stored rather than
  -- derived, so a later zone price change does not silently reprice an
  -- existing member mid-cycle.
  zone_id                INTEGER REFERENCES zones(id),
  price_cents            INTEGER NOT NULL,
  visits_included        INTEGER NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','past_due','cancelled','paused')),
  cycle_start            TEXT NOT NULL,   -- 'YYYY-MM-DD'
  cycle_end              TEXT NOT NULL,
  cancel_at_period_end   INTEGER NOT NULL DEFAULT 0,
  cancelled_at           TEXT,
  stripe_subscription_id TEXT UNIQUE,
  stripe_customer_id     TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_membership_user ON memberships(user_id, status);

-- ===========================================================================
-- FUEL PRICING
-- Justin posts a rate per grade each morning. The rate in force when the
-- customer books is LOCKED onto the order — fuel bills after delivery on
-- actual gallons, but at the rate the customer was shown.
-- ===========================================================================

CREATE TABLE fuel_prices (
  id                INTEGER PRIMARY KEY,
  effective_date    TEXT NOT NULL,     -- 'YYYY-MM-DD'
  fuel_grade        TEXT NOT NULL CHECK (fuel_grade IN ('87','91','diesel')),
  -- Tenths of a cent: $4.899/gal is 4899. Fuel is priced in mills.
  price_mills       INTEGER NOT NULL,
  posted_at         TEXT NOT NULL DEFAULT (datetime('now')),
  posted_by_user_id TEXT REFERENCES users(id),
  UNIQUE (effective_date, fuel_grade)
);

-- ===========================================================================
-- ORDERS
-- One order = one visit = one trip to one location in one window.
-- ===========================================================================

CREATE TABLE orders (
  id                   TEXT PRIMARY KEY,
  invoice_number       TEXT UNIQUE,
  user_id              TEXT NOT NULL REFERENCES users(id),
  location_id          TEXT NOT NULL REFERENCES locations(id),
  zone_id              INTEGER NOT NULL REFERENCES zones(id),
  membership_id        TEXT REFERENCES memberships(id),  -- NULL = non-member

  status               TEXT NOT NULL DEFAULT 'scheduled'
                       CHECK (status IN ('scheduled','confirmed','en_route',
                                         'delivered','cancelled','no_access')),

  delivery_date        TEXT NOT NULL,   -- 'YYYY-MM-DD'
  window_start         TEXT NOT NULL,   -- 'HH:MM' local
  window_end           TEXT NOT NULL,

  -- Snapshot of the address at booking. The customer may edit the saved
  -- location later; the order must still say where Justin actually went.
  address_snapshot     TEXT NOT NULL,
  pin_lat              REAL,
  pin_lng              REAL,
  gate_code_snapshot   TEXT,
  parking_notes        TEXT,

  -- Charged at booking
  delivery_fee_cents   INTEGER NOT NULL DEFAULT 0,
  extra_vehicle_cents  INTEGER NOT NULL DEFAULT 0,
  motorhome_fee_cents  INTEGER NOT NULL DEFAULT 0,
  tip_cents            INTEGER NOT NULL DEFAULT 0,
  booking_total_cents  INTEGER NOT NULL DEFAULT 0,

  -- Settled after delivery
  fuel_total_cents     INTEGER,
  settlement_method    TEXT CHECK (settlement_method IN ('card','cash','mixed')),

  -- Cancellation
  cancelled_at         TEXT,
  cancellation_fee_cents INTEGER NOT NULL DEFAULT 0,
  cancellation_reason  TEXT,

  stripe_booking_pi    TEXT,   -- payment intent for the booking charge
  stripe_fuel_pi       TEXT,   -- payment intent for the post-delivery charge

  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at         TEXT,
  en_route_at          TEXT,
  delivered_at         TEXT
);
CREATE INDEX idx_orders_user ON orders(user_id, created_at DESC);
CREATE INDEX idx_orders_schedule ON orders(delivery_date, window_start);
CREATE INDEX idx_orders_status ON orders(status, delivery_date);

-- A visit covers several vehicles. Gallons and the locked rate live here
-- because each vehicle takes a different grade and a different amount.
CREATE TABLE order_vehicles (
  id                 INTEGER PRIMARY KEY,
  order_id           TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  vehicle_id         TEXT NOT NULL REFERENCES vehicles(id),
  vehicle_snapshot   TEXT NOT NULL,   -- JSON: year/make/model/color/plate at booking
  fuel_grade         TEXT NOT NULL CHECK (fuel_grade IN ('87','91','diesel')),
  -- The rate shown to the customer at booking, locked. Not looked up later.
  locked_price_mills INTEGER NOT NULL,
  gallons            REAL,            -- filled in by ops at delivery
  line_total_cents   INTEGER,
  is_extra_vehicle   INTEGER NOT NULL DEFAULT 0,  -- triggered the +$10
  is_motorhome       INTEGER NOT NULL DEFAULT 0   -- triggered the +$40
);
CREATE INDEX idx_order_vehicles ON order_vehicles(order_id);

-- Pump meter photos: the evidence behind the gallons on the invoice.
CREATE TABLE meter_photos (
  id               INTEGER PRIMARY KEY,
  order_id         TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_vehicle_id INTEGER REFERENCES order_vehicles(id),
  r2_key           TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'after'
                   CHECK (kind IN ('before','after')),
  captured_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_meter_photos ON meter_photos(order_id);

CREATE TABLE ratings (
  id          INTEGER PRIMARY KEY,
  order_id    TEXT NOT NULL UNIQUE REFERENCES orders(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  stars       INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  tags        TEXT,           -- JSON array
  comment     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===========================================================================
-- SESSIONS
-- ===========================================================================

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE otp_codes (
  id          INTEGER PRIMARY KEY,
  phone       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_otp_phone ON otp_codes(phone, created_at DESC);
