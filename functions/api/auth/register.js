/**
 * POST /api/auth/register — create an account and text a code.
 *
 * A phone number that already has an account does NOT error. It falls
 * through to sending a code, exactly as sign-in would, and nothing on the
 * existing account is changed.
 *
 * Two reasons. An error here would tell a stranger which numbers are
 * already customers. And someone re-running signup because they lost their
 * phone should not be able to overwrite the name or consents on an account
 * before proving they hold the number.
 *
 * Consents are recorded as given. TCPA treats service messages and
 * marketing as separate permissions, so they are separate columns and
 * neither defaults to on.
 */

import { json, fail, newId } from '../../_shared/lib.js';
import {
  normalizePhone, maskPhone, sendLimits, issueCode, sendSms, CODE_TTL_MINUTES,
} from '../../_shared/auth.js';
import { accessDevCodeAllowed } from '../../_shared/access.js';

const clean = (v, max) => String(v ?? '').trim().slice(0, max);

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return fail('Expected a JSON body'); }

  const phone = normalizePhone(body.phone);
  if (!phone) return fail("That doesn't look like a mobile number.");

  const firstName = clean(body.first_name, 60);
  const lastName = clean(body.last_name, 60);
  if (!firstName) return fail('Enter your first name.');
  if (!lastName) return fail('Enter your last name.');

  const email = clean(body.email, 160).toLowerCase() || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return fail("That email address doesn't look right.");
  }

  // Required: you cannot use the service without accepting the agreement.
  // The waiver itself is signed on the next screen; this is the terms box.
  if (body.accepted_terms !== true) {
    return fail('Please accept the Terms of Service and Privacy Policy to continue.');
  }

  const limits = await sendLimits(env.DB, phone);
  if (limits.cooling_down) {
    return fail(`Give it ${limits.retry_in} more seconds before asking for another code.`, 429);
  }
  if (limits.over_hourly) {
    return fail('Too many codes requested for that number. Try again in an hour.', 429);
  }

  const existing = await env.DB
    .prepare('SELECT id FROM users WHERE phone = ? AND deleted_at IS NULL')
    .bind(phone)
    .first();

  if (!existing) {
    const smsConsent = body.sms_service_consent === true;

    // Anyone signing up while a dev sign-in path is open is a tester, so
    // say so in the row and make the pre-launch cleanup a query instead of
    // someone's memory. Read from the environment only — a client-settable
    // flag would let a visitor label their own account, which is backwards
    // for a field that decides what gets deleted. Both variables are absent
    // on a real deployment, so the safe state is 0 by absence.
    const isTest = env.DEV_CODE_VIA_ACCESS === '1' || env.ENVIRONMENT === 'development';

    await env.DB
      .prepare(
        `INSERT INTO users (id, first_name, last_name, phone, email,
                            sms_service_consent, sms_marketing_consent, sms_consent_at,
                            test_account)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        newId(), firstName, lastName, phone, email,
        smsConsent ? 1 : 0,
        body.sms_marketing_consent === true ? 1 : 0,
        smsConsent || body.sms_marketing_consent === true ? new Date().toISOString() : null,
        isTest ? 1 : 0
      )
      .run();
  }

  const code = await issueCode(env.DB, phone, env.SESSION_SECRET || 'dev-secret');
  const sms = await sendSms(
    env, phone,
    `${code} is your Fitzy sign-in code. It expires in ${CODE_TTL_MINUTES} minutes.`
  );

  const reply = {
    ok: true,
    sent_to: maskPhone(phone),
    expires_in_minutes: CODE_TTL_MINUTES,
    // The client needs to know where to go after verifying. It does not
    // reveal whether the account existed — both paths land on the waiver,
    // which is a no-op for anyone who has already signed the current one.
    next: 'waiver',
  };

  if (!sms.delivered) {
    const host = new URL(request.url).hostname;
    const isLocalHost =
      host === 'localhost' || host === '127.0.0.1' || host === '[::1]' ||
      host === '::1' || host.endsWith('.localhost');

    if (env.ENVIRONMENT === 'development' && isLocalHost) {
      return json({ ...reply, dev_code: code, dev_note: 'SMS is not configured; code returned for local use only.' });
    }
    if (await accessDevCodeAllowed(request, env)) {
      return json({
        ...reply, dev_code: code,
        dev_note: 'SMS is not configured yet. This code is shown because you signed in through Cloudflare Access.',
      });
    }
    if (sms.reason === 'not_configured') {
      return fail('Text messaging is not set up yet, so codes cannot be sent.', 503);
    }
    return fail('Could not send the code. Try again in a moment.', 502);
  }

  return json(reply);
}
