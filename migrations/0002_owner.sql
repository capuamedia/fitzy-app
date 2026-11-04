-- Justin's owner account — the one person who can sign in to the ops
-- dashboard. Without it the live database has no users and nobody can reach
-- ops at all.
--
-- The phone is (805) 630-3805, the public business line: it is printed on
-- fitzyfuel.com and is already the app's support_phone setting. Committing
-- it exposes nothing new. If the owner's sign-in number ever moves to a
-- personal cell, set that with a one-off, uncommitted `wrangler d1 execute`,
-- not a migration.
--
-- Email is left empty until he confirms which inbox he wants receipts and
-- notices sent to.
--
-- Idempotent: if the number already exists (for example a database that was
-- hand-seeded), it is promoted to owner rather than failing.

INSERT INTO users (id, first_name, last_name, phone, is_owner,
                   sms_service_consent, sms_consent_at)
VALUES ('owner-justin', 'Justin', 'Fitzgerald', '+18056303805', 1,
        1, datetime('now'))
ON CONFLICT (phone) DO UPDATE SET
  is_owner   = 1,
  deleted_at = NULL;
