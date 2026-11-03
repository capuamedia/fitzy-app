/**
 * /api/ops/blackouts — days Fitzy is closed regardless of service hours.
 *
 * Blacking out a date stops NEW bookings. It does not cancel deliveries
 * already booked for that day — stranding a customer silently is worse than
 * making Justin deal with the handful already on the books. The count of
 * affected orders is returned so he knows what he has to go and move.
 */

import { json, fail, requireOwner, serviceDate } from '../../_shared/lib.js';

export async function onRequestPost({ request, env }) {
  const who = await requireOwner(request, env.DB);
  if (who instanceof Response) return who;

  let body;
  try { body = await request.json(); } catch { return fail('Expected a JSON body'); }

  const date = body.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return fail('Bad date');
  if (date < serviceDate()) return fail('That date has already passed.');

  const booked = await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM orders
        WHERE delivery_date = ? AND status NOT IN ('cancelled', 'delivered')`
    )
    .bind(date)
    .first();

  // Report the collision once and let the caller decide. Deliveries already
  // booked are not touched either way.
  if (booked.n > 0 && !body.confirm) {
    return json({
      needs_confirmation: true,
      date,
      booked: booked.n,
      message:
        `${booked.n} ${booked.n === 1 ? 'delivery is' : 'deliveries are'} already booked for ` +
        `${date}. Blacking it out stops new bookings but leaves ${booked.n === 1 ? 'that one' : 'those'} ` +
        `in place — you'll need to move or cancel ${booked.n === 1 ? 'it' : 'them'} yourself.`,
    }, 409);
  }

  await env.DB
    .prepare(
      `INSERT INTO blackout_dates (date, reason) VALUES (?, ?)
       ON CONFLICT (date) DO UPDATE SET reason = excluded.reason`
    )
    .bind(date, body.reason || null)
    .run();

  return json({ ok: true, date, booked: booked.n });
}

export async function onRequestDelete({ request, env }) {
  const who = await requireOwner(request, env.DB);
  if (who instanceof Response) return who;

  const date = new URL(request.url).searchParams.get('date');
  if (!date) return fail('Expected a date');

  await env.DB.prepare('DELETE FROM blackout_dates WHERE date = ?').bind(date).run();
  return json({ ok: true, date });
}
