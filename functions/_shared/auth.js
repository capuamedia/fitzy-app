/**
 * Phone sign-in: one-time codes over SMS.
 *
 * Shared by the ops dashboard and, later, the customer app. The rules below
 * are the ones that keep a six-digit code from being guessable in practice —
 * a million combinations is nothing to a script, so the protection is not
 * the code's length, it's the attempt and rate limits around it.
 */

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;         // per code, then it is dead
const MAX_SENDS_PER_HOUR = 5;   // per phone
const RESEND_COOLDOWN_SECONDS = 30;

/* --- phone numbers --------------------------------------------------------
 * Stored and compared in E.164. Without one canonical form, the same person
 * typing (805) 555-1133 and 8055551133 would be two accounts.
 * ------------------------------------------------------------------------- */

export function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length > 11 && digits.length <= 15) return `+${digits}`;
  return null;
}

/** (805) 555-1133 -> "(•••) •••-1133", for confirming without exposing. */
export function maskPhone(e164) {
  const d = String(e164).replace(/\D/g, '');
  return `(•••) •••-${d.slice(-4)}`;
}

/* --- codes ---------------------------------------------------------------- */

/** Six digits from the CSPRNG, not Math.random. */
export function generateCode() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1000000).padStart(6, '0');
}

/**
 * Codes are stored hashed and salted with SESSION_SECRET, so a leaked
 * database row does not hand over a live code.
 */
export async function hashCode(code, phone, secret) {
  const data = new TextEncoder().encode(`${phone}:${code}:${secret}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time compare, so response timing never leaks a partial match. */
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* --- rate limiting -------------------------------------------------------- */

export async function sendLimits(db, phone) {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS sends,
              MAX(created_at) AS last_sent
         FROM otp_codes
        WHERE phone = ? AND created_at > datetime('now', '-1 hour')`
    )
    .bind(phone)
    .first();

  const since = row.last_sent
    ? (Date.now() - Date.parse(row.last_sent + 'Z')) / 1000
    : Infinity;

  return {
    sends: row.sends,
    over_hourly: row.sends >= MAX_SENDS_PER_HOUR,
    cooling_down: since < RESEND_COOLDOWN_SECONDS,
    retry_in: Math.max(0, Math.ceil(RESEND_COOLDOWN_SECONDS - since)),
  };
}

export async function issueCode(db, phone, secret) {
  const code = generateCode();
  const hash = await hashCode(code, phone, secret);

  // Any earlier live code for this phone is retired. Two valid codes at once
  // doubles the guessing surface for no benefit.
  await db
    .prepare(`UPDATE otp_codes SET consumed_at = datetime('now')
               WHERE phone = ? AND consumed_at IS NULL`)
    .bind(phone)
    .run();

  await db
    .prepare(
      `INSERT INTO otp_codes (phone, code_hash, expires_at)
            VALUES (?, ?, datetime('now', ?))`
    )
    .bind(phone, hash, `+${CODE_TTL_MINUTES} minutes`)
    .run();

  return code;
}

/**
 * Returns { ok: true } or { ok: false, reason, message }.
 * Every failure consumes an attempt; the code dies at MAX_ATTEMPTS.
 */
export async function verifyCode(db, phone, code, secret) {
  const row = await db
    .prepare(
      `SELECT id, code_hash, attempts, expires_at
         FROM otp_codes
        WHERE phone = ? AND consumed_at IS NULL
        ORDER BY created_at DESC LIMIT 1`
    )
    .bind(phone)
    .first();

  if (!row) {
    return { ok: false, reason: 'no_code', message: 'That code has expired. Ask for a new one.' };
  }
  if (Date.parse(row.expires_at + 'Z') < Date.now()) {
    return { ok: false, reason: 'expired', message: 'That code has expired. Ask for a new one.' };
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    return { ok: false, reason: 'locked', message: 'Too many tries. Ask for a new code.' };
  }

  await db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run();

  const hash = await hashCode(String(code).trim(), phone, secret);
  if (!timingSafeEqual(hash, row.code_hash)) {
    const left = MAX_ATTEMPTS - (row.attempts + 1);
    return {
      ok: false,
      reason: 'wrong',
      message: left > 0
        ? `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.`
        : 'Too many tries. Ask for a new code.',
    };
  }

  await db.prepare(`UPDATE otp_codes SET consumed_at = datetime('now') WHERE id = ?`)
    .bind(row.id).run();
  return { ok: true };
}

/* --- sessions ------------------------------------------------------------- */

export async function createSession(db, userId) {
  const sid = crypto.randomUUID();
  await db
    .prepare(`INSERT INTO sessions (id, user_id, expires_at)
                   VALUES (?, ?, datetime('now', '+30 days'))`)
    .bind(sid, userId)
    .run();
  return sid;
}

export function sessionCookie(sid, url, { clear = false } = {}) {
  const secure = new URL(url).protocol === 'https:' ? ' Secure;' : '';
  return clear
    ? `fitzy_session=; Path=/; HttpOnly; SameSite=Lax;${secure} Max-Age=0`
    : `fitzy_session=${sid}; Path=/; HttpOnly; SameSite=Lax;${secure} Max-Age=2592000`;
}

/* --- SMS ------------------------------------------------------------------ */

/**
 * Sends via Twilio when configured. When it isn't — local development before
 * the account exists — returns delivered:false so the caller can surface the
 * code instead. That fallback is gated on ENVIRONMENT by the caller, never
 * here, so there is one place to audit.
 */
export async function sendSms(env, to, body) {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM_NUMBER: from } = env;
  if (!sid || !token || !from || sid.startsWith('ACxxx')) {
    return { delivered: false, reason: 'not_configured' };
  }

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${sid}:${token}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { delivered: false, reason: 'twilio_error', status: res.status, detail: detail.slice(0, 300) };
  }
  return { delivered: true };
}

export { CODE_TTL_MINUTES, MAX_ATTEMPTS };
