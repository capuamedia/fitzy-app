-- Fitzy — remove all demo data.
--
--   npm run demo:clear:remote
--
-- Deletes exactly the rows demo_seed.sql created, identified by their
-- 'demo-' id prefix. Leaves owner-justin, the configuration, the posted
-- fuel prices and anything real untouched.
--
-- Run this before the first real customer. A demo order in a live queue
-- beside real ones is how someone drives to an address that is not there.

DELETE FROM orders       WHERE id LIKE 'demo-%';
DELETE FROM memberships  WHERE id LIKE 'demo-%';
DELETE FROM locations    WHERE id LIKE 'demo-%';
DELETE FROM vehicles     WHERE id LIKE 'demo-%';
DELETE FROM sessions     WHERE user_id LIKE 'demo-%';
DELETE FROM users        WHERE id LIKE 'demo-%';

-- order_vehicles, meter_photos and ratings cascade from orders.
-- Fuel prices are deliberately NOT deleted: Justin may have re-posted his
-- own rates over them, and removing a day's rate would break settling for
-- any real delivery on that date.
