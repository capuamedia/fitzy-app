/**
 * GET /api/ops/orders/:id — everything needed to work one delivery.
 *
 * Returns two rates per vehicle: the one QUOTED at booking and the one
 * posted for the DELIVERY DATE, which is what the customer is actually
 * billed. They are the same for a same-day booking. When they differ, the
 * screen shows both so nobody has to work out why the number moved.
 */

import { json, fail, requireOwner, centsToUsd, millsToUsd } from '../../../_shared/lib.js';

export async function onRequestGet({ request, env, params }) {
  const who = await requireOwner(request, env.DB);
  if (who instanceof Response) return who;

  const order = await env.DB
    .prepare(
      `SELECT o.*, u.first_name, u.last_name, u.phone, u.email,
              z.name AS zone_name, z.per_visit_cents,
              m.id AS m_id, m.visits_included, m.cycle_start, m.cycle_end,
              p.name AS plan_name
         FROM orders o
         JOIN users u ON u.id = o.user_id
         JOIN zones z ON z.id = o.zone_id
    LEFT JOIN memberships m ON m.id = o.membership_id
    LEFT JOIN plans p ON p.id = m.plan_id
        WHERE o.id = ?`
    )
    .bind(params.id)
    .first();

  if (!order) return fail('Order not found', 404);

  const { results: vehicles } = await env.DB
    .prepare(
      `SELECT ov.*, v.year, v.make, v.model, v.color, v.plate, v.tank_gallons
         FROM order_vehicles ov
    LEFT JOIN vehicles v ON v.id = ov.vehicle_id
        WHERE ov.order_id = ?
        ORDER BY ov.id`
    )
    .bind(params.id)
    .all();

  // What this delivery actually bills at: the rate posted for its date.
  const { results: dayRates } = await env.DB
    .prepare('SELECT fuel_grade, price_mills FROM fuel_prices WHERE effective_date = ?')
    .bind(order.delivery_date)
    .all();
  const rateFor = Object.fromEntries(dayRates.map((r) => [r.fuel_grade, r.price_mills]));

  const { results: photos } = await env.DB
    .prepare(
      `SELECT id, order_vehicle_id, r2_key, kind, captured_at
         FROM meter_photos WHERE order_id = ? ORDER BY captured_at`
    )
    .bind(params.id)
    .all();

  // Visits used this cycle, counted as VISITS — one trip to one location,
  // however many vehicles were on it. Cancelled visits do not count.
  let visits = null;
  if (order.m_id) {
    const row = await env.DB
      .prepare(
        `SELECT COUNT(*) AS used FROM orders
          WHERE membership_id = ?
            AND status != 'cancelled'
            AND delivery_date BETWEEN ? AND ?`
      )
      .bind(order.m_id, order.cycle_start, order.cycle_end)
      .first();
    visits = {
      used: row.used,
      included: order.visits_included,
      // Past their allowance, a member pays the zone's non-member fee.
      // They are never blocked from booking.
      overage_cents: row.used > order.visits_included ? order.per_visit_cents : 0,
    };
  }

  return json({
    order: {
      ...order,
      due_at_booking: centsToUsd(order.booking_total_cents),
      fuel_total: order.fuel_total_cents === null ? null : centsToUsd(order.fuel_total_cents),
      window: `${order.window_start}–${order.window_end}`,
      is_member: Boolean(order.m_id),
    },
    vehicles: vehicles.map((v) => {
      // Once settled, the billed rate is a fact on the row. Before that, it
      // is whatever is posted for the delivery date — and null if Justin
      // has not posted that day's rate yet.
      const billed = v.billed_price_mills ?? rateFor[v.fuel_grade] ?? null;
      return {
        ...v,
        quoted_display: millsToUsd(v.quoted_price_mills),
        billed_mills: billed,
        billed_display: billed === null ? null : millsToUsd(billed),
        rate_changed: billed !== null && billed !== v.quoted_price_mills,
        line_total: v.line_total_cents === null ? null : centsToUsd(v.line_total_cents),
        photos: photos.filter((p) => p.order_vehicle_id === v.id),
      };
    }),
    // Null means no rate is posted for the delivery date, so nothing here
    // can be billed yet.
    delivery_date_rates: Object.keys(rateFor).length ? rateFor : null,
    photos,
    visits,
    next_actions: nextActions(order.status),
  });
}

/**
 * A delivery moves in one direction. Transitions are enforced server-side
 * as well as hidden in the UI — a stale tab must not be able to send an
 * order backwards.
 */
export function nextActions(status) {
  switch (status) {
    case 'scheduled': return ['confirmed', 'cancelled'];
    case 'confirmed': return ['en_route', 'cancelled'];
    case 'en_route':  return ['delivered', 'no_access'];
    default:          return [];
  }
}
