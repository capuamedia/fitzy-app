/**
 * /api/ops/availability — when Justin works, and how much he can take.
 *
 * This screen decides what customers are able to book, so every change here
 * is a change to the front of the business. Two rules follow from that:
 *
 *   Changes never reach back. Orders already booked keep the window they
 *   were booked into. Closing a Tuesday does not silently cancel Tuesday's
 *   deliveries — it stops NEW ones.
 *
 *   A change that collides with existing bookings is reported before it is
 *   made. Justin is told what he is about to strand and has to say yes.
 */

import {
  json, fail, requireOwner, getSettings, asInt, serviceDate,
  windowsForDay, DAY_NAMES,
} from '../../_shared/lib.js';

const SETTING_KEYS = ['window_length_minutes', 'slots_per_window',
                      'booking_horizon_days', 'min_lead_time_minutes'];

export async function onRequestGet({ request, env }) {
  const who = await requireOwner(request, env.DB);
  if (who instanceof Response) return who;

  const settings = await getSettings(env.DB, SETTING_KEYS);
  const length = asInt(settings.window_length_minutes, 240);
  const capacity = asInt(settings.slots_per_window, 6);

  const { results: hours } = await env.DB
    .prepare('SELECT id, dow, opens_at, closes_at FROM service_hours WHERE active = 1 ORDER BY dow, opens_at')
    .all();

  const { results: blackouts } = await env.DB
    .prepare(`SELECT date, reason FROM blackout_dates WHERE date >= ? ORDER BY date`)
    .bind(serviceDate())
    .all();

  // Orders already on a blacked-out date. These are not cancelled by the
  // blackout; they are surfaced so Justin knows they are still his problem.
  const { results: stranded } = await env.DB
    .prepare(
      `SELECT o.delivery_date, COUNT(*) AS n
         FROM orders o
         JOIN blackout_dates b ON b.date = o.delivery_date
        WHERE o.status NOT IN ('cancelled', 'delivered')
        GROUP BY o.delivery_date`
    )
    .all();

  // Preview exactly what a customer will be offered, per weekday.
  const days = DAY_NAMES.map((name, dow) => {
    const rows = hours.filter((h) => h.dow === dow);
    const windows = windowsForDay(rows, length);
    return {
      dow,
      name,
      open: rows.length > 0,
      periods: rows.map((r) => ({ id: r.id, opens_at: r.opens_at, closes_at: r.closes_at })),
      windows,
      capacity_per_day: windows.length * capacity,
    };
  });

  return json({
    days,
    blackouts: blackouts.map((b) => ({
      ...b,
      booked: stranded.find((s) => s.delivery_date === b.date)?.n ?? 0,
    })),
    settings: {
      window_length_minutes: length,
      slots_per_window: capacity,
      booking_horizon_days: asInt(settings.booking_horizon_days, 14),
      min_lead_time_minutes: asInt(settings.min_lead_time_minutes, 120),
    },
    weekly_capacity: days.reduce((n, d) => n + d.capacity_per_day, 0),
  });
}

export async function onRequestPost({ request, env }) {
  const who = await requireOwner(request, env.DB);
  if (who instanceof Response) return who;

  let body;
  try { body = await request.json(); } catch { return fail('Expected a JSON body'); }

  const statements = [];

  /* --- settings --------------------------------------------------------- */
  if (body.settings) {
    const bounds = {
      window_length_minutes: [30, 720],
      slots_per_window: [1, 50],
      booking_horizon_days: [1, 90],
      min_lead_time_minutes: [0, 1440],
    };
    for (const [key, [lo, hi]] of Object.entries(bounds)) {
      if (body.settings[key] === undefined) continue;
      const v = asInt(body.settings[key], NaN);
      if (!Number.isFinite(v) || v < lo || v > hi) {
        return fail(`${key.replace(/_/g, ' ')} must be between ${lo} and ${hi}.`);
      }
      statements.push(
        env.DB.prepare(`UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?`)
          .bind(String(v), key)
      );
    }
  }

  /* --- service hours ----------------------------------------------------
   * Sent as a whole week. Replacing the set is simpler to reason about than
   * diffing rows, and these are a handful of records.
   * --------------------------------------------------------------------- */
  if (Array.isArray(body.hours)) {
    for (const h of body.hours) {
      const dow = asInt(h.dow, -1);
      if (dow < 0 || dow > 6) return fail('Bad day');
      if (!/^\d{2}:\d{2}$/.test(h.opens_at) || !/^\d{2}:\d{2}$/.test(h.closes_at)) {
        return fail(`Times for ${DAY_NAMES[dow]} must look like 09:00.`);
      }
      if (h.closes_at <= h.opens_at) {
        return fail(`${DAY_NAMES[dow]} closes at or before it opens.`);
      }
    }
    statements.push(env.DB.prepare('DELETE FROM service_hours'));
    for (const h of body.hours) {
      statements.push(
        env.DB.prepare('INSERT INTO service_hours (dow, opens_at, closes_at) VALUES (?, ?, ?)')
          .bind(asInt(h.dow), h.opens_at, h.closes_at)
      );
    }
  }

  if (!statements.length) return fail('Nothing to change');
  await env.DB.batch(statements);

  return json({ ok: true });
}
