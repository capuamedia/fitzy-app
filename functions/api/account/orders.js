/**
 * GET /api/account/orders — the customer's deliveries.
 *
 * ?scope=upcoming  (default) everything not finished, soonest first
 * ?scope=past                finished, most recent first
 * ?limit=n
 *
 * The customer's view of an order, which is not the ops view. It leaves out
 * the driver's working fields and leads with the two things the customer
 * actually wants: when someone is coming, and what it will cost.
 */

import {
  json, fail, currentUser, serviceDate, centsToUsd, millsToUsd, DAY_NAMES,
} from '../../_shared/lib.js';
import { LIVE_ORDER_STATUSES } from '../../_shared/profile.js';

const STATUS_LABELS = {
  // Shorter than the ops wording on purpose: this sits in a chip next to
  // the date on a phone, and "Not yet confirmed" wraps the row.
  scheduled: 'Pending',
  confirmed: 'Confirmed',
  en_route: 'On the way',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  no_access: "Couldn't access",
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Date arithmetic on the service-date string, in UTC on purpose.
 *
 * `today` already arrived as a Pacific calendar date from serviceDate(), so
 * stepping it in UTC moves whole calendar days without a second timezone
 * conversion putting the answer back off by one.
 */
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' -> 'Today', 'Tomorrow', or "Tuesday, Nov 4". */
function readableDate(iso, today) {
  if (iso === today) return 'Today';
  if (iso === addDays(today, 1)) return 'Tomorrow';
  const [y, m, d] = iso.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAY_NAMES[dow]}, ${MONTHS[m - 1]} ${d}`;
}

/** '08:00' -> '8am', '12:30' -> '12:30pm'. */
function readableTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'pm' : 'am';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hour}:${String(m).padStart(2, '0')}${suffix}` : `${hour}${suffix}`;
}

export async function onRequestGet({ request, env }) {
  const user = await currentUser(request, env.DB);
  if (!user) return fail('Not signed in', 401);

  const url = new URL(request.url);
  const scope = url.searchParams.get('scope') === 'past' ? 'past' : 'upcoming';
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 50);

  const live = LIVE_ORDER_STATUSES.map(() => '?').join(',');
  const { results } = await env.DB
    .prepare(
      `SELECT o.*, l.label AS location_label, z.name AS zone_name
         FROM orders o
         JOIN locations l ON l.id = o.location_id
         LEFT JOIN zones z ON z.id = o.zone_id
        WHERE o.user_id = ?
          AND o.status ${scope === 'upcoming' ? 'IN' : 'NOT IN'} (${live})
        ORDER BY o.delivery_date ${scope === 'upcoming' ? 'ASC' : 'DESC'},
                 o.window_start ${scope === 'upcoming' ? 'ASC' : 'DESC'}
        LIMIT ?`
    )
    .bind(user.id, ...LIVE_ORDER_STATUSES, limit)
    .all();

  // One query for all the vehicle lines rather than one per order.
  const ids = results.map((o) => o.id);
  const linesByOrder = new Map();
  if (ids.length) {
    const { results: lines } = await env.DB
      .prepare(
        `SELECT * FROM order_vehicles
          WHERE order_id IN (${ids.map(() => '?').join(',')})
          ORDER BY id ASC`
      )
      .bind(...ids)
      .all();
    for (const line of lines) {
      if (!linesByOrder.has(line.order_id)) linesByOrder.set(line.order_id, []);
      linesByOrder.get(line.order_id).push(line);
    }
  }

  const today = serviceDate();

  const orders = results.map((o) => {
    const lines = linesByOrder.get(o.id) ?? [];
    return {
      id: o.id,
      status: o.status,
      status_label: STATUS_LABELS[o.status] ?? o.status,
      delivery_date: o.delivery_date,
      date_label: readableDate(o.delivery_date, today),
      is_today: o.delivery_date === today,
      window: `${readableTime(o.window_start)} – ${readableTime(o.window_end)}`,
      location: { id: o.location_id, label: o.location_label },
      zone_name: o.zone_name,
      is_member_visit: Boolean(o.membership_id),
      vehicles: lines.map((v) => {
        const snap = (() => { try { return JSON.parse(v.vehicle_snapshot); } catch { return {}; } })();
        return {
          // The snapshot, not the current vehicle row, so an order reads the
          // way it did when it was placed even if the car was since edited.
          display: [snap.year, snap.color, snap.make, snap.model].filter(Boolean).join(' ')
            || `${snap.make ?? 'Vehicle'} ${snap.model ?? ''}`.trim(),
          fuel_grade: v.fuel_grade,
          gallons: v.gallons,
          quoted_rate: millsToUsd(v.quoted_price_mills),
          billed_rate: v.billed_price_mills == null ? null : millsToUsd(v.billed_price_mills),
          line_total: v.line_total_cents == null ? null : centsToUsd(v.line_total_cents),
        };
      }),
      charges: {
        booked_total: centsToUsd(o.booking_total_cents),
        // Fuel is null until the delivery happens. That is the honest state,
        // and the screens say "charged after delivery" rather than showing a
        // zero that looks like a total.
        fuel_total: o.fuel_total_cents == null ? null : centsToUsd(o.fuel_total_cents),
        tip: o.tip_cents ? centsToUsd(o.tip_cents) : null,
        cancellation_fee: o.cancellation_fee_cents ? centsToUsd(o.cancellation_fee_cents) : null,
        grand_total: o.fuel_total_cents == null
          ? null
          : centsToUsd(o.booking_total_cents + o.fuel_total_cents),
      },
      fuel_rate_source_date: o.fuel_rate_source_date ?? null,
    };
  });

  return json({ scope, today, orders });
}
