-- Fitzy — DEMO data for the live database.
--
-- Realistic bookings so Justin can work the dashboard end to end: confirm
-- one, drive one, settle one, look at the week ahead.
--
--   npm run demo:seed:remote    put it in
--   npm run demo:clear:remote   take it all out
--
-- SAFE TO REMOVE, BY CONSTRUCTION. Every row this creates has an id
-- beginning 'demo-', and demo_teardown.sql deletes exactly that. It never
-- touches owner-justin, the config, or anything real.
--
-- Run the teardown before the first real customer. Demo orders sitting in
-- a live queue beside real ones is how someone ends up driving to an
-- address that does not exist.
--
-- Phone numbers are 555 numbers, which cannot be dialled. Addresses are
-- real streets in the service area so the zones and the map behave, but
-- the house numbers are invented.
--
-- Dates use a -8 hour offset because SQLite's date('now') is UTC and the
-- app asks for "today" in Pacific. Without it, everything seeded after 4pm
-- lands on tomorrow and the queue looks empty.

DELETE FROM orders WHERE id LIKE 'demo-%';
DELETE FROM memberships WHERE id LIKE 'demo-%';
DELETE FROM locations WHERE id LIKE 'demo-%';
DELETE FROM vehicles WHERE id LIKE 'demo-%';
DELETE FROM sessions WHERE user_id LIKE 'demo-%';
DELETE FROM users WHERE id LIKE 'demo-%';

-- ---------------------------------------------------------------- people

INSERT INTO users (id, first_name, last_name, phone, email, sms_service_consent, sms_consent_at) VALUES
  ('demo-u1', 'Sarah',  'Chen',     '+15555550111', NULL, 1, datetime('now')),
  ('demo-u2', 'Marcus', 'Webb',     '+15555550112', NULL, 1, datetime('now')),
  ('demo-u3', 'Dana',   'Okafor',   '+15555550113', NULL, 1, datetime('now')),
  ('demo-u4', 'Ray',    'Villalta', '+15555550114', NULL, 0, NULL);

INSERT INTO vehicles (id, user_id, year, make, model, color, plate, fuel_grade, tank_gallons, vehicle_class, is_default) VALUES
  ('demo-v1', 'demo-u1', 2022, 'Toyota',    'Highlander', 'Silver', '9GHK221', '87',     17.9, 'standard',  1),
  ('demo-v2', 'demo-u1', 2020, 'Subaru',    'Outback',    'Green',  '8TRM905', '87',     18.5, 'standard',  0),
  ('demo-v3', 'demo-u2', 2019, 'Ram',       '2500',       'Black',  '7XPL443', 'diesel', 31.0, 'large',     1),
  ('demo-v4', 'demo-u3', 2023, 'BMW',       'X5',         'White',  '9CCV118', '91',     21.9, 'standard',  1),
  ('demo-v5', 'demo-u4', 2017, 'Tiffin',    'Allegro',    'Tan',    'MH44210', 'diesel', 90.0, 'motorhome', 1),
  ('demo-v6', 'demo-u4', 2021, 'Honda',     'CR-V',       'Blue',   '8DWQ372', '87',     14.0, 'standard',  0),
  ('demo-v7', 'demo-u1', 2018, 'Toyota',    'Tacoma',     'Grey',   '7MNB604', '87',     21.1, 'standard',  0);

-- Spread across zones so the pricing differences are visible on screen.
INSERT INTO locations (id, user_id, label, address_line1, city, zip, lat, lng, gate_code, parking_notes, zone_id, geocoded_at, is_default) VALUES
  ('demo-l1', 'demo-u1', 'Home',   '1455 Lynn Rd',        'Thousand Oaks',    '91360', 34.1975, -118.8747, NULL,   'Both cars in the driveway, fuel doors facing the street', 2, datetime('now'), 1),
  ('demo-l2', 'demo-u2', 'Shop',   '2890 Cochran St',     'Simi Valley',      '93065', 34.2694, -118.7815, '2240', 'Truck parked along the back fence', 6, datetime('now'), 1),
  ('demo-l3', 'demo-u3', 'Home',   '3120 Townsgate Rd',   'Westlake Village', '91361', 34.1489, -118.8203, '0714', 'Gated — code at the keypad, then second driveway on the left', 3, datetime('now'), 1),
  ('demo-l4', 'demo-u4', 'Storage','5400 Kanan Rd',       'Agoura Hills',     '91301', 34.1533, -118.7612, NULL,   'Motorhome in space 14, CR-V next to it', 4, datetime('now'), 1);

-- Two members, two pay-per-visit. Cycles anchored on their own signup dates.
INSERT INTO memberships (id, user_id, plan_id, zone_id, price_cents, visits_included, cycle_start, cycle_end) VALUES
  ('demo-m1', 'demo-u1', 1, 2, 5999,  4, date('now','-8 hours','-18 days'), date('now','-8 hours','-18 days','+1 month','-1 day')),
  ('demo-m3', 'demo-u3', 2, 3, 14999, 10, date('now','-8 hours','-6 days'),  date('now','-8 hours','-6 days','+1 month','-1 day'));

-- ------------------------------------------------------------ fuel rates
-- Posted for today so a delivery can actually be settled. Justin can still
-- practise the morning routine by re-posting with his own numbers.
--
-- DO NOTHING on conflict, not an update: if he has already posted a real
-- rate for today, demo data must not quietly replace it with an invented
-- one. This only ever fills a gap.

INSERT INTO fuel_prices (effective_date, fuel_grade, price_mills, posted_by_user_id) VALUES
  (date('now','-8 hours'), '87',     4899, 'owner-justin'),
  (date('now','-8 hours'), '91',     5299, 'owner-justin'),
  (date('now','-8 hours'), 'diesel', 5149, 'owner-justin')
ON CONFLICT (effective_date, fuel_grade) DO NOTHING;

-- ---------------------------------------------------------------- orders
-- Today: one finished and unsettled, one on the way, one to confirm.
-- Then the week ahead, so the strip and "waiting on you" have content.

-- Delivered this morning, gallons not recorded. The queue flags this.
INSERT INTO orders (id, invoice_number, user_id, location_id, zone_id, membership_id,
                    status, delivery_date, window_start, window_end, address_snapshot,
                    parking_notes, delivery_fee_cents, tip_cents, booking_total_cents, delivered_at)
VALUES ('demo-o1', 'FZ-20311', 'demo-u2', 'demo-l2', 6, NULL,
        'delivered', date('now','-8 hours'), '06:30', '10:30',
        '2890 Cochran St, Simi Valley, CA 93065',
        'Truck parked along the back fence', 3499, 700, 4199, datetime('now','-3 hours'));
INSERT INTO order_vehicles (order_id, vehicle_id, vehicle_snapshot, fuel_grade, quoted_price_mills) VALUES
  ('demo-o1', 'demo-v3', '{"year":2019,"make":"Ram","model":"2500","color":"Black","plate":"7XPL443"}', 'diesel', 5149);

-- On the way now. A member, two vehicles, one visit.
INSERT INTO orders (id, invoice_number, user_id, location_id, zone_id, membership_id,
                    status, delivery_date, window_start, window_end, address_snapshot,
                    parking_notes, delivery_fee_cents, tip_cents, booking_total_cents, confirmed_at, en_route_at)
VALUES ('demo-o2', 'FZ-20312', 'demo-u1', 'demo-l1', 2, 'demo-m1',
        'en_route', date('now','-8 hours'), '09:00', '13:00',
        '1455 Lynn Rd, Thousand Oaks, CA 91360',
        'Both cars in the driveway, fuel doors facing the street',
        0, 1000, 1000, datetime('now','-1 day'), datetime('now','-20 minutes'));
INSERT INTO order_vehicles (order_id, vehicle_id, vehicle_snapshot, fuel_grade, quoted_price_mills) VALUES
  ('demo-o2', 'demo-v1', '{"year":2022,"make":"Toyota","model":"Highlander","color":"Silver","plate":"9GHK221"}', '87', 4899),
  ('demo-o2', 'demo-v2', '{"year":2020,"make":"Subaru","model":"Outback","color":"Green","plate":"8TRM905"}',    '87', 4899);

-- This afternoon, not yet confirmed. Motorhome plus a third vehicle, so the
-- +$40 and +$10 add-ons both show.
INSERT INTO orders (id, invoice_number, user_id, location_id, zone_id, membership_id,
                    status, delivery_date, window_start, window_end, address_snapshot,
                    parking_notes, delivery_fee_cents, motorhome_fee_cents, tip_cents, booking_total_cents)
VALUES ('demo-o3', 'FZ-20313', 'demo-u4', 'demo-l4', 4, NULL,
        'scheduled', date('now','-8 hours'), '13:00', '17:00',
        '5400 Kanan Rd, Agoura Hills, CA 91301',
        'Motorhome in space 14, CR-V next to it',
        3999, 4000, 1500, 9499);
INSERT INTO order_vehicles (order_id, vehicle_id, vehicle_snapshot, fuel_grade, quoted_price_mills, is_motorhome) VALUES
  ('demo-o3', 'demo-v5', '{"year":2017,"make":"Tiffin","model":"Allegro","color":"Tan","plate":"MH44210"}', 'diesel', 5149, 1),
  ('demo-o3', 'demo-v6', '{"year":2021,"make":"Honda","model":"CR-V","color":"Blue","plate":"8DWQ372"}',    '87',     4899, 0);

-- Tomorrow, unconfirmed. VIP member behind a gate.
INSERT INTO orders (id, invoice_number, user_id, location_id, zone_id, membership_id,
                    status, delivery_date, window_start, window_end, address_snapshot,
                    gate_code_snapshot, parking_notes, delivery_fee_cents, tip_cents, booking_total_cents)
VALUES ('demo-o4', 'FZ-20314', 'demo-u3', 'demo-l3', 3, 'demo-m3',
        'scheduled', date('now','-8 hours','+1 day'), '06:30', '10:30',
        '3120 Townsgate Rd, Westlake Village, CA 91361', '0714',
        'Gated — code at the keypad, then second driveway on the left',
        0, 1000, 1000);
INSERT INTO order_vehicles (order_id, vehicle_id, vehicle_snapshot, fuel_grade, quoted_price_mills) VALUES
  ('demo-o4', 'demo-v4', '{"year":2023,"make":"BMW","model":"X5","color":"White","plate":"9CCV118"}', '91', 5299);

-- Tomorrow afternoon, unconfirmed.
INSERT INTO orders (id, invoice_number, user_id, location_id, zone_id,
                    status, delivery_date, window_start, window_end, address_snapshot,
                    gate_code_snapshot, delivery_fee_cents, tip_cents, booking_total_cents)
VALUES ('demo-o5', 'FZ-20315', 'demo-u2', 'demo-l2', 6,
        'scheduled', date('now','-8 hours','+1 day'), '13:00', '17:00',
        '2890 Cochran St, Simi Valley, CA 93065', '2240', 3499, 500, 3999);
INSERT INTO order_vehicles (order_id, vehicle_id, vehicle_snapshot, fuel_grade, quoted_price_mills) VALUES
  ('demo-o5', 'demo-v3', '{"year":2019,"make":"Ram","model":"2500"}', 'diesel', 5149);

-- Two days out, already confirmed.
INSERT INTO orders (id, invoice_number, user_id, location_id, zone_id, membership_id,
                    status, delivery_date, window_start, window_end, address_snapshot,
                    delivery_fee_cents, tip_cents, booking_total_cents, confirmed_at)
VALUES ('demo-o6', 'FZ-20316', 'demo-u1', 'demo-l1', 2, 'demo-m1',
        'confirmed', date('now','-8 hours','+2 days'), '09:00', '13:00',
        '1455 Lynn Rd, Thousand Oaks, CA 91360', 0, 800, 800, datetime('now','-2 hours'));
INSERT INTO order_vehicles (order_id, vehicle_id, vehicle_snapshot, fuel_grade, quoted_price_mills) VALUES
  ('demo-o6', 'demo-v1', '{"year":2022,"make":"Toyota","model":"Highlander"}', '87', 4899);

-- Four days out, unconfirmed. A MEMBER with three vehicles on one visit:
-- the plan covers the visit and the first two vehicles, the third is +$10.
-- This is the case worth having in the demo, because "members pay the extra
-- vehicle fee too" is a rule Justin confirmed and would otherwise never see
-- on screen. Delivery fee is $0 — the plan covers it.
INSERT INTO orders (id, invoice_number, user_id, location_id, zone_id, membership_id,
                    status, delivery_date, window_start, window_end, address_snapshot,
                    parking_notes, delivery_fee_cents, extra_vehicle_cents, tip_cents, booking_total_cents)
VALUES ('demo-o7', 'FZ-20317', 'demo-u1', 'demo-l1', 2, 'demo-m1',
        'scheduled', date('now','-8 hours','+4 days'), '09:00', '13:00',
        '1455 Lynn Rd, Thousand Oaks, CA 91360',
        'Three this time — the Tacoma is on the street', 0, 1000, 800, 1800);
INSERT INTO order_vehicles (order_id, vehicle_id, vehicle_snapshot, fuel_grade, quoted_price_mills, is_extra_vehicle) VALUES
  ('demo-o7', 'demo-v1', '{"year":2022,"make":"Toyota","model":"Highlander","color":"Silver","plate":"9GHK221"}', '87', 4899, 0),
  ('demo-o7', 'demo-v2', '{"year":2020,"make":"Subaru","model":"Outback","color":"Green","plate":"8TRM905"}',    '87', 4899, 0),
  ('demo-o7', 'demo-v7', '{"year":2018,"make":"Toyota","model":"Tacoma","color":"Grey","plate":"7MNB604"}',      '87', 4899, 1);
