/**
 * Shared helpers for Fitzy Pages Functions.
 *
 * Money is integer cents everywhere. Fuel is integer mills (tenths of a
 * cent) because gas is priced that way: $4.899/gal is 4899.
 */

export const TIMEZONE = 'America/Los_Angeles';

/* --- responses ----------------------------------------------------------- */

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

export const fail = (message, status = 400) => json({ error: message }, status);

/* --- dates ---------------------------------------------------------------
 * A delivery date is a calendar day in the service area, not an instant.
 * Everything that asks "what is today" has to ask in Justin's timezone, or
 * a booking made at 5pm Pacific lands on tomorrow's queue.
 * ------------------------------------------------------------------------- */

export function serviceDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now); // en-CA gives YYYY-MM-DD
}

export function serviceTime(now = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now); // HH:MM
}

/* --- money ----------------------------------------------------------------
 * Formatting lives here so a cents-to-dollars conversion is never written
 * inline somewhere and rounded differently.
 * ------------------------------------------------------------------------- */

export const centsToUsd = (cents) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** Mills to a per-gallon display string: 4899 -> "$4.899" */
export const millsToUsd = (mills) => `$${(mills / 1000).toFixed(3)}`;

/** Gallons x rate in mills -> integer cents, rounded once, at the end. */
export function fuelLineCents(gallons, priceMills) {
  return Math.round((gallons * priceMills) / 10);
}

/* --- config ---------------------------------------------------------------
 * Settings are rows, not constants. Read them; never hardcode a price, a
 * fee, an hour or a capacity in application code.
 * ------------------------------------------------------------------------- */

export async function getSettings(db, keys = null) {
  const q = keys
    ? db.prepare(
        `SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`
      ).bind(...keys)
    : db.prepare('SELECT key, value FROM settings');
  const { results } = await q.all();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

export const asInt = (v, fallback = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

export const asBool = (v) => v === 'true' || v === '1';

/* --- auth -----------------------------------------------------------------
 * Session id is an opaque random token in an httpOnly cookie. The ops
 * surface additionally requires users.is_owner.
 * ------------------------------------------------------------------------- */

export function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export async function currentUser(request, db) {
  const sid = readCookie(request, 'fitzy_session');
  if (!sid) return null;
  return db
    .prepare(
      `SELECT u.* FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = ?
          AND s.expires_at > datetime('now')
          AND u.deleted_at IS NULL`
    )
    .bind(sid)
    .first();
}

/**
 * Guard for every /api/ops/* route. Returns the owner, or a Response to
 * return immediately. Callers:
 *
 *   const who = await requireOwner(request, env.DB);
 *   if (who instanceof Response) return who;
 */
export async function requireOwner(request, db) {
  const user = await currentUser(request, db);
  if (!user) return fail('Not signed in', 401);
  if (!user.is_owner) return fail('Not authorized', 403);
  return user;
}

export const newId = () => crypto.randomUUID();
