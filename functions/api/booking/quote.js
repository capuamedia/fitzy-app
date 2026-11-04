/**
 * POST /api/booking/quote — what this delivery would cost.
 *
 * The screens call this on every change rather than adding up fees in
 * JavaScript. Two implementations of the same price card drift the moment
 * one of them is edited, and the one on the phone is the one the customer
 * reads, so it should not be the copy.
 *
 * Nothing is written. This is the same calculation POST /api/booking runs
 * again on its own before it writes anything.
 */

import { json, fail, currentUser, getSettings, serviceDate, centsToUsd } from '../../_shared/lib.js';
import {
  SETTING_KEYS, priceVisit, ratesFor, chargeLines, activeMembership, addDays,
} from '../../_shared/booking.js';

/**
 * Resolve what the client asked for into rows it actually owns.
 *
 * Every id is re-read scoped to the session's user. A quote built from ids
 * the client sent without that check would price someone else's motorhome,
 * and the booking endpoint would then write it.
 */
export async function resolveSelection(db, userId, body) {
  const locationId = String(body.location_id ?? '');
  const vehicleIds = Array.isArray(body.vehicle_ids) ? body.vehicle_ids.map(String) : [];

  if (!locationId) return { error: 'Pick an address.' };
  if (!vehicleIds.length) return { error: 'Pick at least one vehicle.' };

  const location = await db
    .prepare(
      `SELECT l.*, z.id AS zid, z.name AS zone_name, z.per_visit_cents,
              z.monthly_price_cents, z.active AS zone_active
         FROM locations l LEFT JOIN zones z ON z.id = l.zone_id
        WHERE l.id = ? AND l.user_id = ? AND l.deleted_at IS NULL`
    )
    .bind(locationId, userId)
    .first();

  if (!location) return { error: 'No such address.' };
  if (!location.zid || !location.zone_active) {
    return { error: `We don't deliver to ${location.zip} yet.` };
  }

  const { results: vehicles } = await db
    .prepare(
      `SELECT * FROM vehicles
        WHERE user_id = ? AND deleted_at IS NULL
          AND id IN (${vehicleIds.map(() => '?').join(',')})`
    )
    .bind(userId, ...vehicleIds)
    .all();

  if (vehicles.length !== vehicleIds.length) {
    return { error: 'One of those vehicles is no longer on your account.' };
  }

  return {
    location,
    vehicles,
    zone: {
      id: location.zid,
      name: location.zone_name,
      per_visit_cents: location.per_visit_cents,
      monthly_price_cents: location.monthly_price_cents,
    },
  };
}

export async function onRequestPost({ request, env }) {
  const user = await currentUser(request, env.DB);
  if (!user) return fail('Not signed in', 401);

  let body;
  try { body = await request.json(); } catch { return fail('Expected a JSON body'); }

  const settings = await getSettings(env.DB, SETTING_KEYS);
  const picked = await resolveSelection(env.DB, user.id, body);
  if (picked.error) return fail(picked.error);

  const today = serviceDate();
  const deliveryDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.delivery_date ?? ''))
    ? body.delivery_date
    : today;

  const membership = await activeMembership(env.DB, user.id);

  const price = priceVisit({
    zone: picked.zone,
    vehicles: picked.vehicles,
    membership,
    tipCents: Number(body.tip_cents) || 0,
    settings,
  });

  const rates = await ratesFor(env.DB, deliveryDate, settings);

  return json({
    delivery_date: deliveryDate,
    zone: { id: picked.zone.id, name: picked.zone.name },
    vehicles: picked.vehicles.map((v) => ({
      id: v.id,
      display: [v.year, v.color, v.make, v.model].filter(Boolean).join(' '),
      fuel_grade: v.fuel_grade,
      vehicle_class: v.vehicle_class,
    })),
    price,
    total: centsToUsd(price.booking_total_cents),
    rates: {
      quoted_for_date: rates.quoted_for_date,
      bills_on_date: rates.bills_on_date,
      rate_is_final: rates.rate_is_final,
      rate_note: rates.rate_note,
      staleness: rates.stale,
    },
    charges: chargeLines(price, rates),
    // What the membership screen would offer, so Review can say what
    // joining would have saved on this exact order rather than in general.
    membership_pitch: price.is_member ? null : {
      monthly: centsToUsd(picked.zone.monthly_price_cents),
      would_save_cents: price.delivery_fee_cents,
      would_save: centsToUsd(price.delivery_fee_cents),
    },
  });
}
