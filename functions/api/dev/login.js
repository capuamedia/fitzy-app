/**
 * /api/dev/login — local development only.
 *
 * Signs you in as the seeded owner so the ops screens are reachable before
 * the real phone-OTP login exists.
 *
 * This route REFUSES to run unless env.ENVIRONMENT is exactly "development".
 * That var is set in wrangler.toml [vars] for local dev and must never be
 * set to "development" on the deployed project. If this ever responds on a
 * real domain, treat it as an incident: the ops dashboard is wide open.
 */

import { json, fail, newId } from '../../_shared/lib.js';

export async function onRequestPost({ request, env }) {
  if (env.ENVIRONMENT !== 'development') {
    return fail('Not found', 404);
  }

  const owner = await env.DB
    .prepare(`SELECT id, first_name FROM users WHERE is_owner = 1 AND deleted_at IS NULL LIMIT 1`)
    .first();

  if (!owner) {
    return fail(
      'No owner account found. Run `npm run db:reset:local` to seed one.',
      404
    );
  }

  const sid = newId();
  await env.DB
    .prepare(
      `INSERT INTO sessions (id, user_id, expires_at)
            VALUES (?, ?, datetime('now', '+30 days'))`
    )
    .bind(sid, owner.id)
    .run();

  const url = new URL(request.url);
  const secure = url.protocol === 'https:' ? ' Secure;' : '';

  return new Response(
    JSON.stringify({ ok: true, signed_in_as: owner.first_name }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie':
          `fitzy_session=${sid}; Path=/; HttpOnly; SameSite=Lax;${secure} Max-Age=2592000`,
      },
    }
  );
}
