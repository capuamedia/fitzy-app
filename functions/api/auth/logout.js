/**
 * POST /api/auth/logout — end this session.
 *
 * The row is deleted rather than just the cookie cleared, so a copied
 * session id stops working too.
 */

import { readCookie } from '../../_shared/lib.js';
import { sessionCookie } from '../../_shared/auth.js';

export async function onRequestPost({ request, env }) {
  const sid = readCookie(request, 'fitzy_session');
  if (sid) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': sessionCookie(null, request.url, { clear: true }),
    },
  });
}
