/**
 * GET /api/ops/schedule?days=14 — the week ahead at a glance.
 *
 * The queue answers "what am I doing now". This answers "what is coming,
 * and where is it tight". Those are different jobs: one is a run sheet read
 * standing next to a truck, the other is planning done sitting down.
 *
 * Per day it returns what is booked against what can be taken, so a day
 * filling up is visible before it is full.
 */

import {
  json, requireOwner, serviceDate, getSettings, asInt,
  windowsForDay, daysBetween,
} from '../../_shared/lib.js';

export async function onRequestGet({ request, env }) {
  const who = await requireOwner(request, env.DB);
  if (who instanceof Response) return who;

  const url = new URL(request.url);
  const today = serviceDate();
  const from = url.searchParams.get('from') || today;
  const span = Math.min(Math.max(asInt(url.searchParams.get('days'), 14), 1), 60);

  const settings = await getSettings(env.DB, ['window_length_minutes', 'slots_per_window']);
  const length = asInt(settings.window_length_minutes, 240);
  const capacity = asInt(settings.slots_per_window, 6);

  const { results: hours } = await env.DB
    .prepare('SELECT dow, opens_at, closes_at FROM service_hours WHERE active = 1')
    .all();

  // Windows per weekday, computed once rather than per day in the range.
  const perDow = {};
  for (let dow = 0; dow < 7; dow++) {
    perDow[dow] = windowsForDay(hours.filter((h) => h.dow === dow), length);
  }

  const dates = [];
  for (let i = 0; i < span; i++) {
    const d = new Date(`${from}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  const last = dates[dates.length - 1];

  const { results: counts } = await env.DB
    .prepare(
      `SELECT delivery_date, status, COUNT(*) AS n
         FROM orders
        WHERE delivery_date BETWEEN ? AND ?
        GROUP BY delivery_date, status`
    )
    .bind(from, last)
    .all();

  const { results: blackouts } = await env.DB
    .prepare('SELECT date FROM blackout_dates WHERE date BETWEEN ? AND ?')
    .bind(from, last)
    .all();
  const blacked = new Set(blackouts.map((b) => b.date));

  const days = dates.map((date) => {
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    const windows = perDow[dow];
    const rows = counts.filter((c) => c.delivery_date === date);
    const by = (s) => rows.find((r) => r.status === s)?.n ?? 0;

    // Cancelled deliveries free their slot back up.
    const booked = rows.reduce((n, r) => n + (r.status === 'cancelled' ? 0 : r.n), 0);
    const isOpen = windows.length > 0 && !blacked.has(date);
    const slots = isOpen ? windows.length * capacity : 0;

    // Deliveries still on the books for a day Fitzy is not working. Hours can
    // change after a booking is taken — that is deliberate, since changes
    // never reach backward — so this covers a blackout AND a weekday that has
    // since been closed. Either way nobody cancelled these, and Justin still
    // has to move or honour them.
    const stranded = isOpen ? 0 : booked - (rows.find((r) => r.status === 'delivered')?.n ?? 0);

    return {
      date,
      dow,
      is_today: date === today,
      open: isOpen,
      blacked_out: blacked.has(date),
      windows: windows.length,
      capacity: slots,
      booked,
      remaining: Math.max(0, slots - booked),
      stranded: Math.max(0, stranded),
      counts: {
        scheduled: by('scheduled'),
        confirmed: by('confirmed'),
        en_route: by('en_route'),
        delivered: by('delivered'),
        cancelled: by('cancelled'),
        no_access: by('no_access'),
      },
    };
  });

  // Everything still waiting on a confirmation, across the whole range.
  // This is the planning job: confirming days ahead rather than on the day.
  const { results: pending } = await env.DB
    .prepare(
      `SELECT o.id, o.delivery_date, o.window_start, o.window_end,
              o.address_snapshot, o.membership_id,
              u.first_name, u.last_name,
              z.name AS zone_name,
              (SELECT COUNT(*) FROM order_vehicles ov WHERE ov.order_id = o.id) AS vehicle_count
         FROM orders o
         JOIN users u ON u.id = o.user_id
         JOIN zones z ON z.id = o.zone_id
        WHERE o.status = 'scheduled' AND o.delivery_date BETWEEN ? AND ?
        ORDER BY o.delivery_date, o.window_start`
    )
    .bind(from, last)
    .all();

  return json({
    from,
    today,
    days,
    to_confirm: pending.map((p) => ({
      ...p,
      is_member: Boolean(p.membership_id),
      window: `${p.window_start}–${p.window_end}`,
      days_away: daysBetween(today, p.delivery_date),
    })),
    totals: {
      booked: days.reduce((n, d) => n + d.booked, 0),
      capacity: days.reduce((n, d) => n + d.capacity, 0),
      to_confirm: pending.length,
      stranded: days.reduce((n, d) => n + d.stranded, 0),
    },
  });
}
