/**
 * POST /api/auth/verify-code — trade a valid code for a session.
 */

import { json, fail } from '../../_shared/lib.js';
import { normalizePhone, verifyCode, createSession, sessionCookie } from '../../_shared/auth.js';

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return fail('Expected a JSON body'); }

  const phone = normalizePhone(body.phone);
  if (!phone) return fail("That doesn't look like a phone number.");
  if (!/^\d{6}$/.test(String(body.code || '').trim())) return fail('Enter the six-digit code.');

  const result = await verifyCode(env.DB, phone, body.code, env.SESSION_SECRET || 'dev-secret');
  if (!result.ok) return fail(result.message, result.reason === 'locked' ? 429 : 401);

  const user = await env.DB
    .prepare('SELECT id, first_name, is_owner FROM users WHERE phone = ? AND deleted_at IS NULL')
    .bind(phone)
    .first();

  // A code only ever gets issued for a real, eligible user, so this is a
  // belt-and-braces check rather than an expected path.
  if (!user) return fail('No account for that number.', 401);
  if (body.scope === 'ops' && !user.is_owner) return fail('That account cannot open the dashboard.', 403);

  const sid = await createSession(env.DB, user.id);

  return new Response(
    JSON.stringify({ ok: true, first_name: user.first_name, is_owner: Boolean(user.is_owner) }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': sessionCookie(sid, request.url),
      },
    }
  );
}
