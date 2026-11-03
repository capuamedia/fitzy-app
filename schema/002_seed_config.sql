-- Fitzy Mobile Fueling — configuration seed
--
-- Every number here is a business decision, not an implementation detail.
-- Changing a price, a fee, an hour or a capacity means editing a row — never
-- editing application code and never a deploy.
--
-- Values marked ASSUMED are defaults pending Justin's answers. See the
-- running questions doc; the question number is given on each line.

-- ===========================================================================
-- ZONES
-- Monthly plan price and per-visit fee both key off the delivery zone.
-- ===========================================================================

INSERT INTO zones (id, slug, name, monthly_price_cents, per_visit_cents, sort_order) VALUES
  (1, 'newbury-park',     'Newbury Park',        5999, 2499, 1),
  (2, 'thousand-oaks',    'Thousand Oaks',       5999, 2499, 2),
  (3, 'westlake-village', 'Westlake Village',    6999, 3499, 3),
  (4, 'agoura-hills',     'Agoura Hills',        6999, 3999, 4),
  (5, 'moorpark',         'Moorpark',            6999, 3499, 5),
  (6, 'simi-west',        'Simi Valley (West)',  6999, 3499, 6),
  (7, 'simi-east',        'Simi Valley (East)',  7499, 3999, 7);

-- Zip → zone. ASSUMED for the Simi split (Q21): 93065 west, 93063 east.
-- "West end" and "east end" cannot be coded; these are the real boundaries
-- until Justin confirms. An address whose zip is absent here is out of area.
INSERT INTO zone_zips (zip, zone_id) VALUES
  ('91320', 1),   -- Newbury Park
  ('91358', 2),   -- Thousand Oaks
  ('91360', 2),
  ('91361', 3),   -- Westlake Village
  ('91362', 3),
  ('91301', 4),   -- Agoura Hills
  ('91376', 4),
  ('93021', 5),   -- Moorpark
  ('93065', 6),   -- Simi Valley west   [ASSUMED — Q21]
  ('93063', 7);   -- Simi Valley east   [ASSUMED — Q21]

-- ===========================================================================
-- PLANS
-- Standard takes its price from the member's zone (price_cents NULL).
-- VIP is flat across all zones. [ASSUMED — Q5]
-- ===========================================================================

INSERT INTO plans (id, slug, name, price_cents, visits_included,
                   includes_tire_check, includes_window_wash, sort_order) VALUES
  (1, 'standard', 'Fitzy Standard', NULL,  4,  0, 0, 1),
  (2, 'vip',      'Fitzy VIP',      14999, 10, 1, 1, 2);

-- ===========================================================================
-- SERVICE HOURS
-- dow: 0=Sun 1=Mon ... 6=Sat. A day with no row is closed.
-- Weekends closed [ASSUMED — Q14]. The 7-10pm Mon/Wed/Fri evening block is
-- NOT seeded [ASSUMED — Q15]; add a row per day to switch it on.
-- ===========================================================================

INSERT INTO service_hours (dow, opens_at, closes_at) VALUES
  (1, '09:00', '17:00'),   -- Monday
  (2, '06:30', '21:30'),   -- Tuesday
  (3, '09:00', '17:00'),   -- Wednesday
  (4, '06:30', '21:30'),   -- Thursday
  (5, '09:00', '17:00');   -- Friday

-- ===========================================================================
-- SETTINGS
-- ===========================================================================

INSERT INTO settings (key, value, description) VALUES
  -- Pricing add-ons. Round by decision: these are fees, not prices, and they
  -- read better in a running tally. The .99 convention applies to what the
  -- customer buys, not to fees and tips.
  ('extra_vehicle_cents', '1000',
   'Charged per vehicle beyond the first two, per visit. Applies to members too. CONFIRMED by Justin 2026-11-03'),
  ('motorhome_fee_cents', '4000',
   'Charged per motorhome, separate from and on top of vehicle fees'),
  ('vehicles_included_per_visit', '2',
   'Vehicles covered by the base delivery fee or by one member visit'),

  -- Cancellation
  ('cancellation_fee_cents', '2500',
   'Charged when a customer cancels inside the cutoff'),
  ('cancellation_cutoff_minutes', '120',
   'Free cancellation up to this many minutes before the window START [ASSUMED - Q34]'),
  ('cancellation_refunds_tip', 'true',
   'Tip is always refunded on cancellation - the driver did not drive [ASSUMED - Q41]'),

  -- Scheduling
  ('window_length_minutes', '240',
   'Length of each bookable delivery window [ASSUMED - Q39: 4h recommended over 2h for routing]'),
  ('slots_per_window', '6',
   'Maximum deliveries bookable in one window [ASSUMED - Q13: answer together with Q39]'),
  ('booking_horizon_days', '14',
   'How far ahead customers can book [ASSUMED - Q16]'),
  ('min_lead_time_minutes', '120',
   'Windows starting sooner than this show as too soon to book [ASSUMED - Q17]'),
  ('getting_full_threshold', '2',
   'Show a "spots left" chip at or below this many remaining. Hidden above it'),

  -- Membership
  ('overage_policy', 'per_visit_rate',
   'A member past their included visits pays the non-member per-visit fee for the delivery zone. They are never blocked from booking. CONFIRMED by Justin 2026-11-03'),

  -- Billing renews on the signup-date anniversary, not a shared date for
  -- everyone. Avoids proration on every mid-month signup, spreads deposits
  -- across the month, and - the operational reason - staggers when visit
  -- counters reset, so demand does not spike on one day. CONFIRMED 2026-11-03.
  ('billing_anchor', 'signup_anniversary',
   'signup_anniversary | fixed_day. Stripe default behaviour; the cycle anchors to the subscription creation date'),
  ('billing_short_month_rule', 'last_day',
   'A cycle anchored on the 29th, 30th or 31st bills on the last day of a shorter month, then returns to its anchor day'),
  ('plan_follows_customer', 'true',
   'Member plan covers deliveries anywhere in the service area, not just their own zone [ASSUMED - Q9, STRUCTURAL]'),
  ('plan_change_proration', 'none',
   'Plan changes take effect next cycle [ASSUMED - Q10]'),

  -- Fuel pricing
  ('fuel_price_mode', 'posted_daily_billed_on_delivery_date',
   'Rate is posted each morning; fuel bills at the rate posted ON THE DELIVERY DATE. The booking quote is a quote, not a lock. CONFIRMED 2026-11-03'),
  ('fuel_price_post_by', '07:00',
   'Rates are expected to be posted by this time each service day'),

  -- Contact. Config, not hardcoded, so a business line or a hired driver is
  -- a settings change rather than a deploy [Q44].
  ('support_phone', '+18056303805',
   'The only customer-facing contact number. Appears on five screens'),
  ('support_email', 'PLACEHOLDER',
   'Unconfirmed - Q43'),
  ('support_response_time', 'PLACEHOLDER',
   'Unconfirmed - Q43. A stated response time is a promise Justin has to keep'),

  -- Legal
  ('waiver_current_version', '1.0',
   'Matches the Batch 1 footer: Version 1.0, effective July 30 2026'),
  ('terms_current_version', 'PENDING',
   'Terms of Service does not exist yet - Q28, blocks launch'),

  -- Notifications
  ('receipts_always_sent', 'true',
   'Receipts are the record of a charge and cannot be switched off'),

  -- Service area
  ('timezone', 'America/Los_Angeles', 'Service area timezone for all dates'),
  ('fuel_grades', '87,91,diesel', 'Offered grades. There is no 89');
