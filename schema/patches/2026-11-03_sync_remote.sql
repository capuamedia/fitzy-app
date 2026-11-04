-- One-off patch for the REMOTE fitzy-db, which was created from 001/002 as of
-- commit 2c36a7c (2026-11-03), before these changes landed:
--   3d70182  confirm member add-on fee and overage rule; anniversary billing
--   ef98dfa  bill fuel at the delivery date's rate, not the booking quote
--
-- Brings that database in line with the current 001_init.sql and
-- 002_seed_config.sql without dropping anything. Do NOT run this on a database
-- built from the current files — they already contain these changes and the
-- column rename will fail.
--
--   npx wrangler d1 execute fitzy-db --remote --file=./schema/patches/2026-11-03_sync_remote.sql

-- Structure ----------------------------------------------------------------

ALTER TABLE orders ADD COLUMN fuel_rate_source_date TEXT;

ALTER TABLE order_vehicles RENAME COLUMN locked_price_mills TO quoted_price_mills;
ALTER TABLE order_vehicles ADD COLUMN billed_price_mills INTEGER;

-- Settings -----------------------------------------------------------------

INSERT INTO settings (key, value, description) VALUES
  ('extra_vehicle_cents', '1000',
   'Charged per vehicle beyond the first two, per visit. Applies to members too. CONFIRMED by Justin 2026-11-03'),
  ('overage_policy', 'per_visit_rate',
   'A member past their included visits pays the non-member per-visit fee for the delivery zone. They are never blocked from booking. CONFIRMED by Justin 2026-11-03'),
  ('billing_anchor', 'signup_anniversary',
   'signup_anniversary | fixed_day. Stripe default behaviour; the cycle anchors to the subscription creation date'),
  ('billing_short_month_rule', 'last_day',
   'A cycle anchored on the 29th, 30th or 31st bills on the last day of a shorter month, then returns to its anchor day'),
  ('fuel_price_mode', 'posted_daily_billed_on_delivery_date',
   'Rate is posted each morning; fuel bills at the rate posted ON THE DELIVERY DATE. The booking quote is a quote, not a lock. CONFIRMED 2026-11-03')
ON CONFLICT(key) DO UPDATE SET
  value       = excluded.value,
  description = excluded.description,
  updated_at  = datetime('now');
