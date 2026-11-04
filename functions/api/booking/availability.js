/**
 * GET /api/booking/availability          — the bookable days, for the strip
 * GET /api/booking/availability?date=... — the windows on one day
 *
 * The customer's view of the calendar. It never reports a window as simply
 * unavailable: a closed day, a blacked-out date, a full window and one that
 * starts too soon are four different answers, and only one of them means
 * "try a different day".
 */

import { json, fail, currentUser, getSettings, serviceDate } from '../../_shared/lib.js';
import { SETTING_KEYS, bookableDays, windowsForDate, addDays } from '../../_shared/booking.js';

export async function onRequestGet({ request, env }) {
  const user = await currentUser(request, env.DB);
  if (!user) return fail('Not signed in', 401);

  const settings = await getSettings(env.DB, SETTING_KEYS);
  const date = new URL(request.url).searchParams.get('date');

  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail('Bad date');

    const today = serviceDate();
    const horizon = addDays(today, Number(settings.booking_horizon_days ?? 14) - 1);
    // Checked server-side as well as in the strip, because a hand-typed
    // date is the one that gets past the UI.
    if (date < today) return fail('That date has passed.');
    if (date > horizon) return fail(`We take bookings up to ${horizon}.`);

    return json(await windowsForDate(env.DB, date, settings));
  }

  return json({
    today: serviceDate(),
    days: await bookableDays(env.DB, settings),
  });
}
