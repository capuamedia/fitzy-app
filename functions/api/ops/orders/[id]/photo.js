/**
 * POST /api/ops/orders/:id/photo — upload a pump meter photo.
 *
 * These are the evidence behind the gallons on an invoice. A customer can
 * verify a fuel charge instead of trusting it, which is the whole argument
 * for post-delivery billing.
 *
 * They are also photographs taken on a customer's property and kept in a
 * billing record, so the bucket is private and images are only ever served
 * through an authenticated route. Never a public R2 URL.
 */

import { json, fail, requireOwner, newId } from '../../../../_shared/lib.js';

const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

export async function onRequestPost({ request, env, params }) {
  const who = await requireOwner(request, env.DB);
  if (who instanceof Response) return who;

  if (!env.PHOTOS) {
    return fail('Photo storage is not configured on this environment', 503);
  }

  const order = await env.DB
    .prepare('SELECT id FROM orders WHERE id = ?')
    .bind(params.id)
    .first();
  if (!order) return fail('Order not found', 404);

  let form;
  try { form = await request.formData(); } catch { return fail('Expected a file upload'); }

  const file = form.get('photo');
  if (!file || typeof file === 'string') return fail('No photo in the upload');
  if (file.size > MAX_BYTES) return fail('That photo is too large. Keep it under 12MB.');
  if (file.type && !ALLOWED.includes(file.type)) {
    return fail(`Photos must be JPEG, PNG, WebP or HEIC. That one is ${file.type}.`);
  }

  const kind = form.get('kind') === 'before' ? 'before' : 'after';
  const ovRaw = form.get('order_vehicle_id');
  let orderVehicleId = null;
  if (ovRaw) {
    const row = await env.DB
      .prepare('SELECT id FROM order_vehicles WHERE id = ? AND order_id = ?')
      .bind(ovRaw, params.id)
      .first();
    if (!row) return fail('That vehicle is not on this order');
    orderVehicleId = row.id;
  }

  const key = `orders/${params.id}/${newId()}`;
  await env.PHOTOS.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'image/jpeg' },
    customMetadata: { order_id: params.id, uploaded_by: who.id },
  });

  const res = await env.DB
    .prepare(
      `INSERT INTO meter_photos (order_id, order_vehicle_id, r2_key, kind)
            VALUES (?, ?, ?, ?)`
    )
    .bind(params.id, orderVehicleId, key, kind)
    .run();

  return json({
    ok: true,
    photo: {
      id: res.meta?.last_row_id ?? null,
      r2_key: key,
      kind,
      order_vehicle_id: orderVehicleId,
      url: `/api/ops/photo?key=${encodeURIComponent(key)}`,
    },
  });
}
