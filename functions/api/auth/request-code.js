/**
 * POST /api/auth/request-code — text a sign-in code.
 *
 * The response is the same whether or not the number belongs to anyone.
 * Otherwise this endpoint becomes a way to ask "is this person a Fitzy
 * customer?", which is not a question a stranger should be able to answer.
 * Rate limits are reported honestly, because those are about the caller's
 * own behaviour and leak nothing.
 */

import { json, fail } from '../../_shared/lib.js';
import {
  normalizePhone, maskPhone, sendLimits, issueCode, sendSms, CODE_TTL_MINUTES,
} from '../../_shared/auth.js';

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return fail('Expected a JSON body'); }

  const phone = normalizePhone(body.phone);
  if (!phone) return fail("That doesn't look like a phone number.");

  // Scope: the ops login only signs in owners. Asking for a code from the
  // ops screen for a customer's number must not work.
  const ownerOnly = body.scope === 'ops';

  const limits = await sendLimits(env.DB, phone);
  if (limits.cooling_down) {
    return fail(`Give it ${limits.retry_in} more seconds before asking for another code.`, 429);
  }
  if (limits.over_hourly) {
    return fail('Too many codes requested for that number. Try again in an hour.', 429);
  }

  const user = await env.DB
    .prepare('SELECT id, is_owner FROM users WHERE phone = ? AND deleted_at IS NULL')
    .bind(phone)
    .first();

  const eligible = user && (!ownerOnly || user.is_owner);

  // Uniform response shape, built before the branch so the two paths cost
  // roughly the same and look identical from outside.
  const reply = {
    ok: true,
    sent_to: maskPhone(phone),
    expires_in_minutes: CODE_TTL_MINUTES,
  };

  if (!eligible) return json(reply);

  const code = await issueCode(env.DB, phone, env.SESSION_SECRET || 'dev-secret');
  const sms = await sendSms(
    env,
    phone,
    `${code} is your Fitzy sign-in code. It expires in ${CODE_TTL_MINUTES} minutes.`
  );

  // Before Twilio exists, hand the code back so local development works.
  // Gated on ENVIRONMENT here, at the one place it can leak.
  if (!sms.delivered) {
    if (env.ENVIRONMENT === 'development') {
      return json({ ...reply, dev_code: code, dev_note: 'SMS is not configured; code returned for local use only.' });
    }
    if (sms.reason === 'not_configured') {
      return fail('Text messaging is not set up yet, so codes cannot be sent.', 503);
    }
    return fail('Could not send the code. Try again in a moment.', 502);
  }

  return json(reply);
}
