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

### Getting the trailer to actually parse

Two things have to be true, and both have been got wrong in this repo:

1. The trailer sits in the **last block** of the message, alongside
   `Co-Authored-By`, with no blank line splitting them.
2. If the value wraps, **every continuation line is indented.** An
   unindented second line is not trailer-shaped, which stops git reading
   the block as trailers at all — so the `Infra:` line silently vanishes
   even though the text is plainly there in `git log`.

```
Infra: apply migration 0003, and add the Access bypass for
  /api/stripe/webhook — indented, so this line belongs to the
  trailer above it rather than ending the block.
Co-Authored-By: ...
```

A single long line works too; it is the unindented wrap that fails.

**Check before pushing**, because the failure is invisible in `git log`:

```
git log -1 --format='%(trailers:key=Infra,valueonly)'
```

Empty output means the trailer did not parse. Amend and check again.
`.githooks/commit-msg` catches this automatically — enable it once per
clone with:

```
git config core.hooksPath .githooks
```

## Layout

- `migrations/` — applied in order, tracked by Wrangler, never edited after
- `schema/002_seed_config.sql` — config for a fresh database
- `schema/003_seed_dev.sql` — local-only sample data; never run on remote
- `schema/patches/` — one-off repairs already applied by hand; history only
