# Fitzy Mobile Fueling — App

Customer app and ops dashboard for Fitzy Mobile Fueling, an on-demand fuel
delivery service in the greater Conejo Valley, California.

Built by Capua Media. Client: Justin Fitzgerald.

---

## Stack

Everything runs on Cloudflare, in the same account as the marketing site.

| Piece | What it is |
|---|---|
| Cloudflare Pages | Static front end for the customer app and ops dashboard |
| Pages Functions | API routes under `functions/api/` |
| D1 | SQLite database — orders, users, vehicles, pricing config |
| R2 | Pump meter photos, private, served through a signed Function |
| Stripe | Subscriptions and one-off charges |
| Twilio | Order status texts |
| Google Maps Platform | Geocoding (server-side only), autocomplete, map pin |

## First-time setup

```bash
npm install

npm run db:create        # paste the returned database_id into wrangler.toml
npm run r2:create

cp .dev.vars.example .dev.vars    # fill in test keys; .dev.vars is gitignored

npm run db:reset:local   # create tables and seed config
npm run dev
```

## Layout

```
functions/api/     API routes (Pages Functions)
public/app/        Customer-facing app
public/ops/        Owner dashboard (Justin)
schema/            SQL migrations and config seed
docs/              Business rules, design references
```

---

## Two things to understand before changing anything

### 1. Business rules live in the database, not in code

Prices, fees, service hours, slot capacity, the cancellation window, the
support phone number — all of it is rows in `settings`, `zones`, `plans` and
`service_hours`. None of it is hardcoded.

This is deliberate. Roughly a dozen of these values are still assumptions
waiting on the client, and several will change again after launch. Changing
one must be a row edit, not a code change and a deploy.

If you find yourself typing a dollar amount into a `.js` file, stop.

### 2. Money is integer cents; fuel is integer mills

`$69.99` is stored as `6999`. Never floats — a float cent error in a billing
system is a chargeback.

Fuel is the exception: gas is priced in tenths of a cent, so `$4.899/gal` is
stored as `4899` mills in `fuel_prices.price_mills`.

---

## The business model, in short

**A membership is counted in visits, not vehicles.** One visit is one trip to
one location at one time, covering up to two vehicles. Two cars fuelled at the
same stop is one visit; the same two cars on Monday and Thursday is two
visits. This is the single most misunderstood thing about the product and the
schema is built around it.

**Pricing varies by zone.** The delivery address is geocoded once when the
customer saves it, the zip resolves to a zone, and the zone carries both the
monthly plan price and the non-member per-visit fee. Booking never calls the
Maps API — the zone is already on the location row, so pricing is
deterministic, auditable, and survives a Google outage.

**Money moves twice.** The delivery fee and tip are charged at booking. Fuel
is charged after delivery, on actual gallons pumped, at the rate that was
posted that morning and **locked onto the order when the customer booked**.
The customer always knows the rate before committing; they just don't know the
gallons yet. Every screen that shows money has to keep those two halves
visually distinct.

**Meter photos are the proof.** Justin photographs the pump meter at each
fill. Those photos are referenced from the invoice and are the reason a
customer can verify a fuel charge rather than trust it. They live in R2 and
are never publicly readable.

Full detail, including every open question and the default currently built
against it, is in the running questions doc shared with the client.

---

## Status

Scaffold, schema and config seed are in place. Nothing is wired up yet.

Design is complete for 33 of 41 screens — Batches 1 through 5, produced in
Claude Design. Batch 6 (three system states and five ops screens) is built
directly in code with no design pass.

**Not yet done and blocking launch:** Terms of Service. The signup screen
links to a Terms page and a Privacy Policy that do not exist. The membership
is an auto-renewing subscription, which brings it under California's
Automatic Renewal Law — specific disclosure, affirmative consent and easy
online cancellation. The subscribe flow is designed for it; the legal text
behind it still has to be written and reviewed by a California attorney.
