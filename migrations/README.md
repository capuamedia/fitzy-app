# Migrations

The remote database is live. These files are applied to it in order and
tracked by Wrangler, so the rules are the ones that apply to any live
schema — not the ones that applied while this was a throwaway local file.

```
npm run db:migrate:local    # apply pending migrations locally
npm run db:migrate:remote   # apply pending migrations to the remote D1
npm run db:status           # what the remote has actually applied
```

## Rules

**Never edit a migration that has been applied.** `0001_init.sql` is applied
on the remote. Editing it changes nothing there and silently puts the code
out of step with the database — which has already happened twice on this
project, both times fixed by hand.

**Each change is the next numbered file.** `0002_`, `0003_`, and so on.
Additive where possible: `ALTER TABLE ... ADD COLUMN` rather than a rebuild.

SQLite, which D1 is built on, cannot drop or alter a `CHECK` constraint or a
foreign key in place. Changing one means creating the new table, copying the
rows, dropping the old, renaming. Write that out in full in the migration
rather than hoping an `ALTER` covers it.

**Config changes go in two places.** A setting change belongs in the
migration as an idempotent upsert:

```sql
INSERT INTO settings (key, value, description) VALUES ('x', 'y', '...')
ON CONFLICT (key) DO UPDATE SET value = excluded.value,
                                description = excluded.description;
```

and also in `schema/002_seed_config.sql`, so a database created from scratch
comes out identical to one that got there by migration. Two places is not
ideal, but the alternative is a fresh install that differs from production.

**Renaming or dropping a column?** Update `schema/003_seed_dev.sql` in the
same commit, or the dev seed breaks for everyone.

**Flag it in the commit.** Add a trailer so the infra session catches it:

```
Infra: new migration 0004
Infra: new secret RESEND_API_KEY
Infra: new binding
```

## Layout

- `migrations/` — applied in order, tracked by Wrangler, never edited after
- `schema/002_seed_config.sql` — config for a fresh database
- `schema/003_seed_dev.sql` — local-only sample data; never run on remote
- `schema/patches/` — one-off repairs already applied by hand; history only
