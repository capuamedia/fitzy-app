/**
 * POST /api/booking — place a delivery.
 *
 * The client sends what was picked, never what it costs. Totals arrive from
 * the browser the way anything else from a browser arrives: as a claim. So
 * this re-runs the same quote the Review screen showed, from the same
 * function, and writes its own numbers.
 *
 * Capacity and lead time are re-checked here too. The window the customer
 * chose may have filled while they were deciding on a tip, and the
 * availability call that drew the screen was a read, not a reservation.
 */

import {
  json, fail, currentUser, getSettings, newId, serviceDate, centsToUsd,
} from '../../_shared/lib.js';
import {
  SETTING_KEYS, priceVisit, ratesFor, chargeLines, activeMembership,
  windowsForDate, addDays,
} from '../../_shared/booking.js';
import { resolveSelection } from './quote.js';

const MAX_TIP_CENTS = 20000;

export async function onRequestPost({ request, env }) {
  const user = await currentUser(request, env.DB);
  if (!user) return fail('Not signed in', 401);

  let body;
  try { body = await request.json(); } catch { return fail('Expected a JSON body'); }

  // Setup has to be finished. Booking is the one action that turns the
  // app into a visit from a real person, so an unsigned waiver stops here
  // rather than being caught later by someone reading a job card.
  const settings = await getSettings(env.DB, [...SETTING_KEYS, 'waiver_current_version']);
  const signed = await env.DB
    .prepare(
      `SELECT version FROM waiver_acceptances
        WHERE user_id = ? AND document = 'liability_waiver'
        ORDER BY accepted_at DESC LIMIT 1`
    )
    .bind(user.id)
    .first();
  if (!signed || signed.version !== settings.waiver_current_version) {
    return fail('Please sign the customer agreement before booking.', 403);
  }

  const picked = await resolveSelection(env.DB, user.id, body);
  if (picked.error) return fail(picked.error);

  /* --- the slot ----------------------------------------------------- */

  const date = String(body.delivery_date ?? '');
  const start = String(body.window_start ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail('Pick a date.');
  if (!/^\d{2}:\d{2}$/.test(start)) return fail('Pick a time window.');

  const today = serviceDate();
  const horizon = addDays(today, Number(settings.booking_horizon_days ?? 14) - 1);
  if (date < today) return fail('That date has passed.');
  if (date > horizon) return fail(`We take bookings up to ${horizon}.`);

  const day = await windowsForDate(env.DB, date, settings);
  if (!day.open) {
    return fail(day.reason === 'blackout'
      ? `We're not delivering on ${date}.`
      : `We don't deliver on that day.`);
  }
  const slot = day.windows.find((w) => w.start === start);
  if (!slot) return fail('That time window is not one we offer.');
  if (!slot.available) {
    // Say which of the two it is. "Unavailable" sends someone to a
    // different day when the real answer might be "pick a later window".
    return fail(
      slot.reason === 'too_soon'
        ? 'That window starts too soon. Please pick a later one.'
        : 'That window just filled up. Please pick another.',
      409
    );
  }

  /* --- the money, computed here and not trusted from the client ----- */

  const tipCents = Math.min(Math.max(0, Math.round(Number(body.tip_cents) || 0)), MAX_TIP_CENTS);
  const membership = await activeMembership(env.DB, user.id);

  const price = priceVisit({
    zone: picked.zone,
    vehicles: picked.vehicles,
    membership,
    tipCents,
    settings,
  });
  const rates = await ratesFor(env.DB, date, settings);

  // If the client sent a total, compare rather than use. A mismatch means
  // the price moved under the customer between Review and Confirm, and
  // they should see the new one instead of being charged either number.
  if (body.expect_total_cents != null
      && Number(body.expect_total_cents) !== price.booking_total_cents) {
    return json({
      error: 'The price changed while you were booking. Please check it and try again.',
      expected: Number(body.expect_total_cents),
      actual: price.booking_total_cents,
      actual_display: centsToUsd(price.booking_total_cents),
      charges: chargeLines(price, rates),
    }, 409);
  }

  /* --- write -------------------------------------------------------- */

  const loc = picked.location;
  const orderId = newId();

  // Snapshots, not references. The customer can edit or remove the saved
  // address and vehicles afterwards; the order has to keep saying where
  // Justin actually went and what he actually filled.
  const addressSnapshot = JSON.stringify({
    label: loc.label,
    address_line1: loc.address_line1,
    address_line2: loc.address_line2,
    city: loc.city,
    state: loc.state,
    zip: loc.zip,
  });

  const included = price.vehicles_included;
  let standardSeen = 0;

  const statements = [
    env.DB.prepare(
      `INSERT INTO orders (
         id, user_id, location_id, zone_id, membership_id, status,
         delivery_date, window_start, window_end,
         address_snapshot, gate_code_snapshot, parking_notes,
         fuel_rate_source_date,
         delivery_fee_cents, extra_vehicle_cents, motorhome_fee_cents,
         tip_cents, booking_total_cents
       ) VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
    ).bind(
      orderId, user.id, loc.id, picked.zone.id,
      price.covered_by_plan ? membership.id : null,
      date, slot.start, slot.end,
      addressSnapshot, loc.gate_code ?? null,
      // Notes the customer typed for this one delivery override the saved
      // ones; otherwise the address's standing notes come along.
      (String(body.notes ?? '').trim().slice(0, 400) || loc.parking_notes) ?? null,
      price.delivery_fee_cents, price.extra_vehicle_cents,
      price.motorhome_fee_cents, price.tip_cents, price.booking_total_cents
    ),
  ];

  for (const v of picked.vehicles) {
    const isMotorhome = v.vehicle_class === 'motorhome';
    if (!isMotorhome) standardSeen += 1;
    const isExtra = !isMotorhome && standardSeen > included;

    statements.push(
      env.DB.prepare(
        `INSERT INTO order_vehicles (
           order_id, vehicle_id, vehicle_snapshot, fuel_grade,
           quoted_price_mills, billed_price_mills, is_extra_vehicle, is_motorhome
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
      ).bind(
        orderId, v.id,
        JSON.stringify({
          year: v.year, make: v.make, model: v.model,
          color: v.color, plate: v.plate,
          fuel_grade: v.fuel_grade, vehicle_class: v.vehicle_class,
        }),
        v.fuel_grade,
        // The rate SHOWN at booking, kept for the receipt so a customer can
        // see what moved. billed_price_mills stays null until delivery and
        // is what actually charges.
        rates.quoted[v.fuel_grade]?.mills ?? 0,
        isExtra ? 1 : 0,
        isMotorhome ? 1 : 0
      )
    );
  }

  await env.DB.batch(statements);

  return json({
    ok: true,
    order_id: orderId,
    delivery_date: date,
    window: { start: slot.start, end: slot.end },
    total: centsToUsd(price.booking_total_cents),
    charges: chargeLines(price, rates),
    rate_note: rates.rate_note,
  }, 201);
}
