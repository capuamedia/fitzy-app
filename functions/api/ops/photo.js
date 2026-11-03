/**
 * GET /api/ops/photo?key=... — serve one meter photo.
 *
 * The R2 bucket is private. Every image goes through here so that viewing a
 * photograph taken on a customer's driveway requires being signed in.
 *
 * The key is checked against meter_photos rather than trusted from the query
 * string: without that, a signed-in user could walk the bucket by guessing
 * keys. The row lookup is the authorization.
 */

import { fail, requireOwner } from '../../_shared/lib.js';

export async function onRequestGet({ request, env }) {
  const who = await requireOwner(request, env.DB);
  if (who instanceof Response) return who;

  if (!env.PHOTOS) return fail('Photo storage is not configured', 503);

  const key = new URL(request.url).searchParams.get('key');
  if (!key) return fail('Expected a key');

  const known = await env.DB
    .prepare('SELECT r2_key FROM meter_photos WHERE r2_key = ?')
    .bind(key)
    .first();
  if (!known) return fail('Not found', 404);

  const object = await env.PHOTOS.get(key);
  if (!object) return fail('Not found', 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  // Private to the signed-in viewer; never cached by a shared proxy.
  headers.set('cache-control', 'private, max-age=3600');
  return new Response(object.body, { headers });
}
