/**
 * GET  /api/account/me — who is signed in, and what they still need to do.
 * POST /api/account/me — accept the waiver.
 *
 * The onboarding screens read `needs` to decide where to send someone. A
 * customer who quits halfway and comes back lands on the step they were on
 * rather than starting over.
 */

import { json, fail, currentUser, getSettings } from '../../_shared/lib.js';

async function onboardingState(db, user) {
  const settings = await getSettings(db, ['waiver_current_version', 'terms_current_version']);
  const waiverVersion = settings.waiver_current_version;

  const signed = await db
    .prepare(
      `SELECT version, accepted_at FROM waiver_acceptances
        WHERE user_id = ? AND document = 'liability_waiver'
        ORDER BY accepted_at DESC LIMIT 1`
    )
    .bind(user.id)
    .first();

  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM vehicles  WHERE user_id = ? AND deleted_at IS NULL) AS vehicles,
         (SELECT COUNT(*) FROM locations WHERE user_id = ? AND deleted_at IS NULL) AS locations`
    )
    .bind(user.id, user.id)
    .first();

  // Version matters: an amended waiver has to be re-accepted, and the record
  // must say which text each customer agreed to.
  const needsWaiver = !signed || signed.version !== waiverVersion;

  return {
    waiver_version: waiverVersion,
    signed_version: signed?.version ?? null,
    signed_at: signed?.accepted_at ?? null,
    vehicles: counts.vehicles,
    locations: counts.locations,
    needs: [
      needsWaiver ? 'waiver' : null,
      counts.vehicles === 0 ? 'vehicle' : null,
      counts.locations === 0 ? 'location' : null,
    ].filter(Boolean),
  };
}

export async function onRequestGet({ request, env }) {
  const user = await currentUser(request, env.DB);
  if (!user) return fail('Not signed in', 401);

  const state = await onboardingState(env.DB, user);
  return json({
    user: {
      id: user.id,
      first_name: user.first_name,
      last_name: user.last_name,
      phone: user.phone,
      email: user.email,
      is_owner: Boolean(user.is_owner),
      sms_service_consent: Boolean(user.sms_service_consent),
      sms_marketing_consent: Boolean(user.sms_marketing_consent),
    },
    ...state,
  });
}

export async function onRequestPost({ request, env }) {
  const user = await currentUser(request, env.DB);
  if (!user) return fail('Not signed in', 401);

  let body;
  try { body = await request.json(); } catch { return fail('Expected a JSON body'); }

  if (body.action !== 'accept_waiver') return fail('Unknown action');

  const typed = String(body.typed_name ?? '').trim();
  if (typed.length < 3) return fail('Type your full name to sign.');

  // A typed signature that isn't the account's name is worth catching at the
  // point of signing rather than discovering in a dispute.
  const expected = `${user.first_name} ${user.last_name}`.toLowerCase().replace(/\s+/g, ' ');
  if (typed.toLowerCase().replace(/\s+/g, ' ') !== expected) {
    return fail(`Please sign with the name on the account: ${user.first_name} ${user.last_name}.`);
  }

  const settings = await getSettings(env.DB, ['waiver_current_version']);

  await env.DB
    .prepare(
      `INSERT INTO waiver_acceptances
         (user_id, document, version, typed_name, ip_address, user_agent)
       VALUES (?, 'liability_waiver', ?, ?, ?, ?)`
    )
    .bind(
      user.id,
      settings.waiver_current_version,
      typed,
      request.headers.get('cf-connecting-ip') || null,
      (request.headers.get('user-agent') || '').slice(0, 300) || null
    )
    .run();

  const state = await onboardingState(env.DB, user);
  return json({ ok: true, ...state });
}
