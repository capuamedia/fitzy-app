/**
 * What a delivery costs, and when one can be booked.
 *
 * Every money rule lives here and nowhere else. The quote endpoint, the
 * booking endpoint and the ops side all call the same function, so the
 * number a customer is shown at Review is the number that gets written —
 * not a second implementation that agrees with the first until someone
 * edits one of them.
 *
 * Money is integer cents. Fuel is integer mills, tenths of a cent, because
 * a posted rate is $4.899 and storing that as a float loses the third
 * decimal exactly where it matters.
 */

import {
  getSettings, asInt, asBool, serviceDate, serviceTime,
  windowsForDay, effectiveRates, staleness, centsToUsd, millsToUsd,
} from './lib.js';

export const SETTING_KEYS = [
  'window_length_minutes', 'slots_per_window', 'booking_horizon_days',
  'min_lead_time_minutes', 'getting_full_threshold',
  'vehicles_included_per_visit', 'extra_vehicle_cents', 'motorhome_fee_cents',
  'overage_policy', 'cancellation_cutoff_minutes', 'cancellation_fee_cents',
  'cancellation_refunds_tip', 'fuel_price_post_by',
];

/** Calendar arithmetic on a service-date string, without a second tz hop. */
export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export const dowOf = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

const minutesOf = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/* ------------------------------------------------------------ the money -- */

/**
 * Price a visit.
 *
 * `member` is the customer's active membership row or null. The difference
 * is only the base: a member's visit is covered by the plan, a non-member
 * pays the zone's per-visit rate. The per-vehicle and motorhome fees are
 * charged either way — confirmed with Justin, and the reason the member
 * path is not simply "free".
 *
 * Fuel is deliberately absent from the total. It is charged after delivery
 * on actual gallons at the delivery date's posted rate, so any number here
 * would be a guess presented as a bill.
 */
/**
 * The customer's active membership, with visits counted from orders.
 *
 * `visits_used` is not a column, and should not be: a counter would have to
 * be incremented on booking, decremented on cancellation, and corrected
 * whenever either of those went wrong. Counting the orders in the cycle
 * cannot drift from the orders in the cycle.
 *
 * A cancelled visit does not consume one. A delivered or still-scheduled
 * one does, so a member cannot book past their allowance and then have it
 * reappear because nothing has happened yet.
 */
export async function activeMembership(db, userId) {
  const m = await db
    .prepare(
      `SELECT * FROM memberships
        WHERE user_id = ? AND status = 'active'
        ORDER BY cycle_start DESC LIMIT 1`
    )
    .bind(userId)
    .first();
  if (!m) return null;

  const used = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM orders
        WHERE membership_id = ? AND status != 'cancelled'
          AND delivery_date >= ? AND delivery_date <= ?`
    )
    .bind(m.id, m.cycle_start, m.cycle_end)
    .first();

  return { ...m, visits_used: used.n };
}

export function priceVisit({ zone, vehicles, membership, tipCents, settings }) {
  const included = asInt(settings.vehicles_included_per_visit, 2);
  const extraEach = asInt(settings.extra_vehicle_cents, 1000);
  const motorhomeEach = asInt(settings.motorhome_fee_cents, 4000);

  const isMember = Boolean(membership && membership.status === 'active');

  // A member's visit is covered unless they are out of visits, and the
  // overage then costs what a non-member pays — 'per_visit_rate', confirmed.
  const visitsLeft = isMember
    ? Math.max(0, (membership.visits_included ?? 0) - (membership.visits_used ?? 0))
    : 0;
  const coveredByPlan = isMember && visitsLeft > 0;

  const deliveryFeeCents = coveredByPlan ? 0 : (zone?.per_visit_cents ?? 0);

  // Motorhomes are counted separately and never consume an included slot:
  // one carries its own fee, so letting it also use up a slot would charge
  // for the same vehicle twice.
  const motorhomes = vehicles.filter((v) => v.vehicle_class === 'motorhome');
  const standard = vehicles.filter((v) => v.vehicle_class !== 'motorhome');

  const extraVehicles = Math.max(0, standard.length - included);
  const extraVehicleCents = extraVehicles * extraEach;
  const motorhomeFeeCents = motorhomes.length * motorhomeEach;

  const tip = Math.max(0, Math.round(tipCents || 0));
  const bookingTotalCents = deliveryFeeCents + extraVehicleCents + motorhomeFeeCents + tip;

  return {
    is_member: isMember,
    covered_by_plan: coveredByPlan,
    visits_left_after: coveredByPlan ? visitsLeft - 1 : visitsLeft,
    is_overage: isMember && !coveredByPlan,

    delivery_fee_cents: deliveryFeeCents,
    extra_vehicle_count: extraVehicles,
    extra_vehicle_cents: extraVehicleCents,
    motorhome_count: motorhomes.length,
    motorhome_fee_cents: motorhomeFeeCents,
    tip_cents: tip,
    booking_total_cents: bookingTotalCents,

    vehicles_included: included,
    extra_vehicle_each_cents: extraEach,
    motorhome_each_cents: motorhomeEach,
  };
}

/**
 * Today's posted rates, and what to say about them for a given date.
 *
 * Billing happens on the delivery date's rate, so a booking made for Friday
 * is quoted at today's rate and billed at Friday's. That is not a detail to
 * bury: `rate_note` is the sentence the screens show, and it changes
 * wording for today versus a future date rather than showing the same
 * reassurance in both cases.
 */
export async function ratesFor(db, deliveryDate, settings) {
  const today = serviceDate();
  const rates = await effectiveRates(db, today);
  const stale = staleness(rates);
  const isToday = deliveryDate === today;

  return {
    quoted: rates,
    quoted_for_date: today,
    stale,
    bills_on_date: deliveryDate,
    same_day: isToday,

    // Deliberately NOT "today's rate is what you'll be charged", even for a
    // same-day booking. Posting a rate upserts on (effective_date, grade),
    // so Justin can re-post today's rate this afternoon — that sentence is
    // a promise the system can break.
    //
    // Nothing here is ever final at booking anyway: the charge is rate ×
    // gallons, and the gallons are not known until the nozzle clicks off.
    // So every booking gets this card, with the wording that fits its case
    // rather than one case getting silence.
    rate_title: isToday ? "Your fuel charge isn't set yet" : 'Fuel price may change',
    rate_note: isToday
      ? 'Fuel is charged after we fill, on the gallons actually delivered at '
        + "that day's posted rate. Today's rate is shown so you can work out "
        + 'roughly what to expect.'
      : "Fuel is charged at the rate posted on your delivery day, not today's. "
        + "Today's is shown so you know roughly where it sits.",
  };
}

/* --------------------------------------------------------- the calendar -- */

/**
 * The windows a customer can actually pick, for one date.
 *
 * Four things can close a window, and they are reported separately rather
 * than as one "unavailable": the day is not a service day, the date is
 * blacked out, the window is full, or the window starts too soon. A
 * customer who sees "too soon" understands it; one who sees "unavailable"
 * on a visibly empty Tuesday assumes the app is broken.
 */
export async function windowsForDate(db, date, settings) {
  const length = asInt(settings.window_length_minutes, 240);
  const capacity = asInt(settings.slots_per_window, 6);
  const lead = asInt(settings.min_lead_time_minutes, 120);
  const fullAt = asInt(settings.getting_full_threshold, 2);

  const today = serviceDate();
  const nowMinutes = minutesOf(serviceTime());

  const blackout = await db
    .prepare('SELECT reason FROM blackout_dates WHERE date = ?')
    .bind(date)
    .first();

  const { results: hours } = await db
    .prepare('SELECT dow, opens_at, closes_at FROM service_hours WHERE active = 1 AND dow = ? ORDER BY opens_at')
    .bind(dowOf(date))
    .all();

  if (!hours.length) {
    return { date, open: false, reason: 'closed', windows: [] };
  }
  if (blackout) {
    return { date, open: false, reason: 'blackout', note: blackout.reason, windows: [] };
  }

  const { results: taken } = await db
    .prepare(
      `SELECT window_start, COUNT(*) AS n FROM orders
        WHERE delivery_date = ? AND status NOT IN ('cancelled')
        GROUP BY window_start`
    )
    .bind(date)
    .all();
  const used = new Map(taken.map((t) => [t.window_start, t.n]));

  const windows = windowsForDay(hours, length).map((w) => {
    const booked = used.get(w.start) ?? 0;
    const left = Math.max(0, capacity - booked);

    // Lead time is measured to the START of the window: a 2-hour rule means
    // the window must not begin inside the next two hours.
    const tooSoon = date === today && minutesOf(w.start) - nowMinutes < lead;
    const full = left === 0;

    return {
      start: w.start,
      end: w.end,
      label: w.label ?? `${w.start}–${w.end}`,
      spots_left: left,
      available: !full && !tooSoon,
      reason: full ? 'full' : tooSoon ? 'too_soon' : null,
      // Scarcity is shown only when it is real. "8 spots left" reads as
      // nobody uses this service.
      show_scarcity: !full && !tooSoon && left <= fullAt,
    };
  });

  return {
    date,
    open: true,
    reason: null,
    windows,
    any_available: windows.some((w) => w.available),
  };
}

/** The bookable horizon, one entry per day, for the date strip. */
export async function bookableDays(db, settings) {
  const horizon = asInt(settings.booking_horizon_days, 14);
  const today = serviceDate();
  const days = [];
  for (let i = 0; i < horizon; i += 1) {
    const date = addDays(today, i);
    const day = await windowsForDate(db, date, settings);
    days.push({
      date,
      dow: dowOf(date),
      is_today: i === 0,
      open: day.open,
      reason: day.reason,
      available: day.open && day.any_available,
      spots_left: day.open ? day.windows.reduce((n, w) => n + (w.available ? w.spots_left : 0), 0) : 0,
    });
  }
  return days;
}

/* ------------------------------------------------------- cancellation --- */

/**
 * What cancelling this order costs right now.
 *
 * Inside the cutoff there is a fee, because the slot is gone and the day is
 * already routed. The tip is a separate question from the fee, and
 * `cancellation_refunds_tip` decides it.
 */
export function cancellationTerms(order, settings, now = new Date()) {
  const cutoff = asInt(settings.cancellation_cutoff_minutes, 120);
  const feeCents = asInt(settings.cancellation_fee_cents, 2500);
  const refundsTip = asBool(settings.cancellation_refunds_tip);

  const today = serviceDate(now);
  const nowMinutes = minutesOf(serviceTime(now));
  const startMinutes = minutesOf(order.window_start);

  let minutesUntil;
  if (order.delivery_date > today) {
    // Whole days away, so the cutoff cannot possibly have passed.
    minutesUntil = 24 * 60;
  } else if (order.delivery_date < today) {
    minutesUntil = -1;
  } else {
    minutesUntil = startMinutes - nowMinutes;
  }

  const insideCutoff = minutesUntil < cutoff;
  const tipRefunded = refundsTip || !insideCutoff;

  return {
    inside_cutoff: insideCutoff,
    cutoff_minutes: cutoff,
    fee_cents: insideCutoff ? feeCents : 0,
    fee: insideCutoff ? centsToUsd(feeCents) : null,
    tip_refunded: tipRefunded,
    refund_cents: Math.max(
      0,
      order.booking_total_cents
        - (insideCutoff ? feeCents : 0)
        - (tipRefunded ? 0 : (order.tip_cents ?? 0))
    ),
  };
}

/* ------------------------------------------------------------- display -- */

/** The charge lines a screen shows, split by when money actually moves. */
export function chargeLines(price, rates) {
  const now = [];
  if (price.covered_by_plan) {
    now.push({ label: 'Delivery', amount: 'Included', note: 'Covered by your membership', zero: true });
  } else {
    now.push({
      label: 'Delivery',
      amount: centsToUsd(price.delivery_fee_cents),
      note: price.is_overage ? 'Beyond your plan’s visits this cycle' : null,
    });
  }
  if (price.extra_vehicle_count > 0) {
    now.push({
      label: `Extra vehicle × ${price.extra_vehicle_count}`,
      amount: centsToUsd(price.extra_vehicle_cents),
      note: `First ${price.vehicles_included} are included`,
    });
  }
  if (price.motorhome_count > 0) {
    now.push({
      label: price.motorhome_count > 1 ? `Motorhome × ${price.motorhome_count}` : 'Motorhome',
      amount: centsToUsd(price.motorhome_fee_cents),
    });
  }
  if (price.tip_cents > 0) {
    now.push({ label: 'Tip', amount: centsToUsd(price.tip_cents) });
  }

  return {
    now,
    now_total: centsToUsd(price.booking_total_cents),
    // Sits directly under the total so "Total today" can never be read as
    // the total cost of the service.
    now_note: 'Fuel is charged separately, after delivery.',
    later: {
      label: 'Fuel',
      // Never a number. Gallons are not known until the nozzle clicks off,
      // and the rate is the delivery day's.
      amount: 'After delivery',
      note: rates.same_day
        ? 'On the gallons actually delivered, at that day\'s posted rate.'
        : 'On the gallons actually delivered, at the rate posted on your delivery day.',
      // effectiveRates returns {grade: {mills, source_date, carried_forward,
      // days_stale}}, not a bare number. carried_forward matters: it means
      // no rate was posted that morning and the last one is standing in.
      rates: Object.fromEntries(
        Object.entries(rates.quoted || {}).map(([grade, r]) => [
          grade,
          { rate: millsToUsd(r.mills), mills: r.mills, carried_forward: r.carried_forward },
        ])
      ),
    },
  };
}
