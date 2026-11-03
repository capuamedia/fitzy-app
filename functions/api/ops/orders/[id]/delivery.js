/**
 * POST /api/ops/orders/:id/delivery — record gallons and settle the fuel.
 *
 * This is the money step. Everything else in the ops dashboard is bookkeeping;
 * this is the call that decides what a customer is charged.
 *
 * Three rules it exists to protect:
 *
 *   1. Fuel bills at the rate LOCKED on the order at booking, never today's.
 *   2. Each line rounds once, at the end: gallons x mills / 10 -> cents.
 *      Rounding per-gallon or mid-calculation drifts by a cent or two, and a
 *      cent of drift on an invoice is a dispute.
 *   3. A gallon figure far outside the vehicle's tank size is almost always
 *      a misplaced decimal — 145 instead of 14.5 overcharges tenfold. The
 *      caller must confirm explicitly rather than have it waved through.
 */

import { json, fail, requireOwner, fuelLineCents, centsToUsd } from '../../../../_shared/lib.js';

// A fill above this multiple of the tank's capacity is treated as suspect.
// Not blocked outright — a tank size can be wrong, or missing entirely.
const TANK_TOLERANCE = 1.25;

export async function onRequestPost({ request, env, params }) {
  const who = await requireOwner(request, env.DB);
  if (who instanceof Response) return who;

  let body;
  try { body = await request.json(); } catch { return fail('Expected a JSON body'); }

  const order = await env.DB
    .prepare('SELECT id, status, booking_total_cents FROM orders WHERE id = ?')
    .bind(params.id)
    .first();
  if (!order) return fail('Order not found', 404);
  if (order.status === 'cancelled') return fail('This order was cancelled', 409);

  const { results: vehicles } = await env.DB
    .prepare(
      `SELECT ov.id, ov.locked_price_mills, ov.fuel_grade,
              v.make, v.model, v.tank_gallons
         FROM order_vehicles ov
    LEFT JOIN vehicles v ON v.id = ov.vehicle_id
        WHERE ov.order_id = ?`
    )
    .bind(params.id)
    .all();

  const entries = body.gallons;
  if (!entries || typeof entries !== 'object') return fail('Expected gallons per vehicle');

  const statements = [];
  const lines = [];
  const suspect = [];
  let fuelTotal = 0;

  for (const v of vehicles) {
    const raw = entries[String(v.id)];
    if (raw === undefined || raw === null || raw === '') {
      return fail(`Enter gallons for the ${v.make} ${v.model} before settling.`);
    }

    const gallons = parseFloat(String(raw));
    if (!Number.isFinite(gallons) || gallons <= 0) {
      return fail(`Could not read the gallons for the ${v.make} ${v.model}.`);
    }

    if (v.tank_gallons && gallons > v.tank_gallons * TANK_TOLERANCE) {
      suspect.push({
        order_vehicle_id: v.id,
        vehicle: `${v.make} ${v.model}`,
        gallons,
        tank_gallons: v.tank_gallons,
      });
    }

    const cents = fuelLineCents(gallons, v.locked_price_mills);
    fuelTotal += cents;
    lines.push({
      order_vehicle_id: v.id,
      vehicle: `${v.make} ${v.model}`,
      grade: v.fuel_grade,
      gallons,
      rate_mills: v.locked_price_mills,
      line_total_cents: cents,
      line_total: centsToUsd(cents),
    });

    statements.push(
      env.DB
        .prepare('UPDATE order_vehicles SET gallons = ?, line_total_cents = ? WHERE id = ?')
        .bind(gallons, cents, v.id)
    );
  }

  // The caller has to acknowledge a suspect figure. Returned as data, not as
  // a hard error, so the screen can show exactly which line looks wrong.
  if (suspect.length && !body.confirm_unusual) {
    return json({ needs_confirmation: true, suspect, lines, fuel_total: centsToUsd(fuelTotal) }, 409);
  }

  /*
   * Settlement records how the FUEL was paid, which is a separate question
   * from the delivery fee and tip already charged at booking.
   *
   *   card  - charge the card on file for the fuel
   *   cash  - Justin collected cash AND nothing was charged at booking
   *   mixed - Justin collected cash for fuel, but fee and tip went to the
   *           card at booking. This is the normal cash case.
   */
  const paid = body.settlement === 'cash' ? 'cash' : 'card';
  const settlement =
    paid === 'card' ? 'card' : order.booking_total_cents > 0 ? 'mixed' : 'cash';

  statements.push(
    env.DB
      .prepare(
        `UPDATE orders
            SET fuel_total_cents = ?,
                settlement_method = ?,
                status = CASE WHEN status = 'delivered' THEN status ELSE 'delivered' END,
                delivered_at = COALESCE(delivered_at, datetime('now'))
          WHERE id = ?`
      )
      .bind(fuelTotal, settlement, params.id)
  );

  await env.DB.batch(statements);

  return json({
    ok: true,
    lines,
    fuel_total_cents: fuelTotal,
    fuel_total: centsToUsd(fuelTotal),
    due_at_booking: centsToUsd(order.booking_total_cents),
    settlement,
    // Deliberately no combined total. The two charges are separate events
    // on the customer's statement and are never shown summed.
    settled_unusual: suspect.length > 0,
  });
}
