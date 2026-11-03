/**
 * /api/ops/orders — the day's queue.
 *
 * Defaults to today in the service timezone. Orders are grouped by status
 * so the screen reads as a run sheet rather than a table: what is moving
 * now, what is next, what is finished.
 */

import {
  json, requireOwner, serviceDate, centsToUsd,
} from '../../_shared/lib.js';

const ACTIVE = ['scheduled', 'confirmed', 'en_route'];

export async function onRequestGet({ request, env }) {
  const who = await requireOwner(request, env.DB);
  if (who instanceof Response) return who;

  const url = new URL(request.url);
  const date = url.searchParams.get('date') || serviceDate();
  const scope = url.searchParams.get('scope') || 'day';

  const where =
    scope === 'active'
      ? `o.status IN (${ACTIVE.map(() => '?').join(',')})`
      : `o.delivery_date = ?`;
  const binds = scope === 'active' ? ACTIVE : [date];

  const { results } = await env.DB
    .prepare(
      `SELECT o.id, o.invoice_number, o.status,
              o.delivery_date, o.window_start, o.window_end,
              o.address_snapshot, o.gate_code_snapshot, o.parking_notes,
              o.pin_lat, o.pin_lng,
              o.delivery_fee_cents, o.extra_vehicle_cents,
              o.motorhome_fee_cents, o.tip_cents, o.booking_total_cents,
              o.fuel_total_cents, o.settlement_method,
              o.membership_id,
              u.first_name, u.last_name, u.phone,
              z.name AS zone_name,
              (SELECT COUNT(*) FROM order_vehicles ov WHERE ov.order_id = o.id)
                AS vehicle_count,
              (SELECT COUNT(*) FROM order_vehicles ov
                WHERE ov.order_id = o.id AND ov.is_motorhome = 1)
                AS motorhome_count,
              (SELECT COUNT(*) FROM meter_photos mp WHERE mp.order_id = o.id)
                AS photo_count
         FROM orders o
         JOIN users u ON u.id = o.user_id
         JOIN zones z ON z.id = o.zone_id
        WHERE ${where}
        ORDER BY o.window_start, o.created_at`
    )
    .bind(...binds)
    .all();

  const orders = results.map((o) => ({
    ...o,
    is_member: Boolean(o.membership_id),
    due_at_booking: centsToUsd(o.booking_total_cents),
    fuel_total: o.fuel_total_cents === null ? null : centsToUsd(o.fuel_total_cents),
    window: `${o.window_start}–${o.window_end}`,
    // Every delivery needs proof of gallons before it can be settled.
    needs_photos: o.status === 'delivered' && o.photo_count === 0,
    needs_gallons: o.status === 'delivered' && o.fuel_total_cents === null,
  }));

  const by = (s) => orders.filter((o) => o.status === s);

  return json({
    date,
    scope,
    counts: {
      scheduled: by('scheduled').length,
      confirmed: by('confirmed').length,
      en_route: by('en_route').length,
      delivered: by('delivered').length,
      cancelled: by('cancelled').length,
      no_access: by('no_access').length,
    },
    // Orders delivered but not yet settled are the ones that cost money if
    // they are forgotten, so they are surfaced separately rather than
    // sitting quietly at the bottom of the finished list.
    unsettled: orders.filter((o) => o.needs_gallons || o.needs_photos).length,
    orders,
  });
}
