-- Mark accounts created while the dev sign-in path is open.
--
-- Signups on the live site create real `users` rows. The demo seed's
-- teardown only catches its own `demo-` prefixed rows, so tester accounts
-- would survive it and sit in the table on launch day next to real
-- customers, indistinguishable without someone remembering who signed up.
--
-- The flag is set by the server from its own environment, never from
-- anything the client sends. A client-settable field would let a visitor
-- label their own account however they liked, which is exactly backwards
-- for a field whose job is deciding what gets deleted.
--
-- It is set when DEV_CODE_VIA_ACCESS = '1' (the Cloudflare Access preview)
-- or ENVIRONMENT = 'development' (a local machine). Both are absent on a
-- real deployment, so the safe state is 0 by absence rather than by
-- getting a value right.
--
-- Cleanup before the first real customer:
--   SELECT id, first_name, last_name, phone, created_at
--     FROM users WHERE test_account = 1;
-- Review that list, then delete by explicit id. Deleting a user with
-- orders will fail on the foreign keys, which is the correct outcome:
-- a tester with real order rows needs those removed first, deliberately.

ALTER TABLE users ADD COLUMN test_account INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_users_test_account
  ON users (test_account) WHERE test_account = 1;
