-- Fitzy — DEVELOPMENT seed. Local use only.
--
-- Never run this against the remote database. It creates a signed-in owner
-- session with a fixed, published token, which would be an open door in
-- production. The /api/dev/login route that uses it refuses to run unless
-- ENVIRONMENT is "development".
--
--   npm run db:reset:local     runs 001, 002 and this file
--   npm run db:migrate:remote  runs 001 and 002 only

-- Justin — the owner. is_owner = 1 is what gates the ops dashboard.
INSERT INTO users (id, first_name, last_name, phone, email, is_owner,
                   sms_service_consent, sms_consent_at)
VALUES ('dev-owner', 'Justin', 'Fitzgerald', '+18056303805',
        'justin@fitzyfuel.com', 1, 1, datetime('now'));

-- A sample customer with two vehicles and one saved location.
INSERT INTO users (id, first_name, last_name, phone, email, sms_service_consent, sms_consent_at)
VALUES ('dev-cust', 'Mike', 'Capua', '+18055551133', 'mike@capua.media', 1, datetime('now'));

INSERT INTO vehicles (id, user_id, year, make, model, color, plate, fuel_grade, tank_gallons, vehicle_class, is_default) VALUES
  ('dev-v1', 'dev-cust', 2021, 'Honda', 'Pilot',  'Blue',  '8ABC123', '87',     19.5, 'standard', 1),
  ('dev-v2', 'dev-cust', 2019, 'Ford',  'F-150',  'White', '9XYZ456', 'diesel', 26.0, 'large',    0);

INSERT INTO locations (id, user_id, label, address_line1, city, zip, lat, lng,
                       gate_code, parking_notes, zone_id, geocoded_at, is_default)
VALUES ('dev-l1', 'dev-cust', 'Home', '1420 Lynn Rd', 'Thousand Oaks', '91360',
        34.1975, -118.8747, '4417', 'Blue Pilot in the second driveway spot',
        2, datetime('now'), 1);

-- Membership: Thousand Oaks standard plan, 4 visits.
-- The cycle runs from the signup anniversary, not a shared date — signed up
-- on the 12th, so it renews on the 12th.
INSERT INTO memberships (id, user_id, plan_id, zone_id, price_cents, visits_included,
                         cycle_start, cycle_end)
VALUES ('dev-m1', 'dev-cust', 1, 2, 5999, 4,
        date('now', '-22 days'),
        date('now', '-22 days', '+1 month', '-1 day'));

-- Today's posted rates, so booking is not blocked on a fresh database.
INSERT INTO fuel_prices (effective_date, fuel_grade, price_mills, posted_by_user_id) VALUES
  (date('now'), '87',     4899, 'dev-owner'),
  (date('now'), '91',     5299, 'dev-owner'),
  (date('now'), 'diesel', 5149, 'dev-owner');

-- Three orders covering the states the queue has to render:
-- one en route, one delivered but unsettled, one waiting to be confirmed.

INSERT INTO orders (id, invoice_number, user_id, location_id, zone_id, membership_id,
                    status, delivery_date, window_start, window_end,
                    address_snapshot, gate_code_snapshot, parking_notes,
                    delivery_fee_cents, tip_cents, booking_total_cents)
VALUES ('dev-o1', 'FZ-10428', 'dev-cust', 'dev-l1', 2, 'dev-m1',
        'en_route', date('now'), '09:00', '13:00',
        '1420 Lynn Rd, Thousand Oaks, CA 91360', '4417',
        'Blue Pilot in the second driveway spot',
        0, 800, 800);

INSERT INTO order_vehicles (order_id, vehicle_id, vehicle_snapshot, fuel_grade, quoted_price_mills) VALUES
  ('dev-o1', 'dev-v1', '{"year":2021,"make":"Honda","model":"Pilot","color":"Blue","plate":"8ABC123"}', '87',     4899),
  ('dev-o1', 'dev-v2', '{"year":2019,"make":"Ford","model":"F-150","color":"White","plate":"9XYZ456"}', 'diesel', 5149);

-- Delivered, no gallons recorded. This is the one the queue flags.
INSERT INTO orders (id, invoice_number, user_id, location_id, zone_id,
                    status, delivery_date, window_start, window_end,
                    address_snapshot, delivery_fee_cents, tip_cents,
                    booking_total_cents, delivered_at)
VALUES ('dev-o2', 'FZ-10427', 'dev-cust', 'dev-l1', 2,
        'delivered', date('now'), '06:30', '10:30',
        '1420 Lynn Rd, Thousand Oaks, CA 91360', 2499, 500, 2999, datetime('now'));

INSERT INTO order_vehicles (order_id, vehicle_id, vehicle_snapshot, fuel_grade, quoted_price_mills)
VALUES ('dev-o2', 'dev-v1', '{"year":2021,"make":"Honda","model":"Pilot"}', '87', 4899);

INSERT INTO orders (id, invoice_number, user_id, location_id, zone_id,
                    status, delivery_date, window_start, window_end,
                    address_snapshot, gate_code_snapshot,
                    delivery_fee_cents, extra_vehicle_cents, tip_cents, booking_total_cents)
VALUES ('dev-o3', 'FZ-10429', 'dev-cust', 'dev-l1', 2,
        'scheduled', date('now'), '13:00', '17:00',
        '1420 Lynn Rd, Thousand Oaks, CA 91360', '4417',
        2499, 1000, 1000, 4499);

INSERT INTO order_vehicles (order_id, vehicle_id, vehicle_snapshot, fuel_grade, quoted_price_mills, is_extra_vehicle) VALUES
  ('dev-o3', 'dev-v1', '{"year":2021,"make":"Honda","model":"Pilot"}',  '87',     4899, 0),
  ('dev-o3', 'dev-v2', '{"year":2019,"make":"Ford","model":"F-150"}',   'diesel', 5149, 0);
