/**
 * /api/ops/fuel-prices
 *
 * The daily rate per grade. Justin posts these each morning; the rate in
 * force when a customer books is LOCKED onto their order, and fuel bills
 * after delivery on actual gallons at that locked rate.
 *
 * Nothing can be booked on a day with no posted rate — the booking screen
 * has no price to show, and showing yesterday's would be a lie.
 *
 * Rates are stored in mills (tenths of a cent): $4.899/gal is 4899.
 */

import {
  json, fail, requireOwner, serviceDate, millsToUsd, getSettings,
} from '../../_shared/lib.js';

const GRADES = ['87', '91', 'diesel'];

// A rate outside this range is almost certainly a typo — a decimal in the
// wrong place turns $4.899 into $48.99 and bills a customer ten times over.
const MIN_MILLS = 1000;   // $1.000/gal
const MAX_MILLS = 15000;  // $15.000/gal

export async function onRequestGet({ request, env }) {
  const who = await requireOwner(request, env.DB);
  if (who instanceof Response) return who;

  const url = new URL(request.url);
  const date = url.searchParams.get('date') || serviceDate();

  const { results } = await env.DB
    .prepare(
      `SELECT fuel_grade, price_mills, posted_at
         FROM fuel_prices
        WHERE effective_date = ?`
    )
    .bind(date)
    .all();

  const posted = Object.fromEntries(
    results.map((r) => [
      r.fuel_grade,
      { mills: r.price_mills, display: millsToUsd(r.price_mills), posted_at: r.posted_at },
    ])
  );

  // Yesterday's rates are shown only as a starting point for the form. They
  // are explicitly labelled as such and are never presented as current.
  const { results: prev } = await env.DB
    .prepare(
      `SELECT fuel_grade, price_mills, effective_date
         FROM fuel_prices
        WHERE effective_date < ?
        ORDER BY effective_date DESC
        LIMIT 3`
    )
    .bind(date)
    .all();

  const settings = await getSettings(env.DB, ['fuel_price_post_by']);

  return json({
    date,
    grades: GRADES,
    posted,
    complete: GRADES.every((g) => posted[g]),
    previous: Object.fromEntries(
      prev.map((r) => [r.fuel_grade, { mills: r.price_mills, date: r.effective_date }])
    ),
    post_by: settings.fuel_price_post_by || null,
  });
}

export async function onRequestPost({ request, env }) {
  const who = await requireOwner(request, env.DB);
  if (who instanceof Response) return who;

  let body;
  try {
    body = await request.json();
  } catch {
    return fail('Expected a JSON body');
  }

  const date = body.date || serviceDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail('Bad date');

  const prices = body.prices;
  if (!prices || typeof prices !== 'object') return fail('Expected prices');

  const statements = [];
  const accepted = {};

  for (const grade of GRADES) {
    const raw = prices[grade];
    if (raw === undefined || raw === null || raw === '') continue;

    // Accept either mills (4899) or a dollar string ("4.899"). The form
    // sends dollars because that is what Justin reads off the pump.
    const mills =
      typeof raw === 'number' && Number.isInteger(raw)
        ? raw
        : Math.round(parseFloat(String(raw).replace(/[^0-9.]/g, '')) * 1000);

    if (!Number.isFinite(mills)) return fail(`Could not read the ${grade} price`);
    if (mills < MIN_MILLS || mills > MAX_MILLS) {
      return fail(
        `${millsToUsd(mills)} per gallon for ${grade} looks wrong. ` +
        `Enter a price between ${millsToUsd(MIN_MILLS)} and ${millsToUsd(MAX_MILLS)}.`
      );
    }

    accepted[grade] = mills;
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO fuel_prices (effective_date, fuel_grade, price_mills, posted_by_user_id)
                VALUES (?, ?, ?, ?)
           ON CONFLICT (effective_date, fuel_grade)
           DO UPDATE SET price_mills = excluded.price_mills,
                         posted_at = datetime('now'),
                         posted_by_user_id = excluded.posted_by_user_id`
        )
        .bind(date, grade, mills, who.id)
    );
  }

  if (!statements.length) return fail('No prices to save');

  await env.DB.batch(statements);

  return json({
    ok: true,
    date,
    saved: Object.fromEntries(
      Object.entries(accepted).map(([g, m]) => [g, millsToUsd(m)])
    ),
    complete: GRADES.every((g) => accepted[g] !== undefined),
  });
}
