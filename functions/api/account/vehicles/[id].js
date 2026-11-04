/**
 * PATCH  /api/account/vehicles/:id — edit one, or make it the default.
 * DELETE /api/account/vehicles/:id — remove it.
 *
 * Removal is a soft delete. Orders keep their own `vehicle_snapshot`, so
 * history survives either way, but a row that still has a delivery coming
 * cannot be removed without leaving that delivery pointing at nothing.
 */

import { json, fail, currentUser } from '../../../_shared/lib.js';
import { readVehicle, setDefaultStatements, LIVE_ORDER_STATUSES } from '../../../_shared/profile.js';
import { shape } from '../vehicles.js';

async function owned(db, userId, id) {
  return db
    .prepare('SELECT * FROM vehicles WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(id, userId)
    .first();
}

export async function onRequestPatch({ request, env, params }) {
  const user = await currentUser(request, env.DB);
  if (!user) return fail('Not signed in', 401);

  const vehicle = await owned(env.DB, user.id, params.id);
  if (!vehicle) return fail('No such vehicle', 404);

  let body;
  try { body = await request.json(); } catch { return fail('Expected a JSON body'); }

  const { value, errors } = readVehicle({ ...vehicle, ...body }, { patch: true });
  if (errors.length) return fail(errors[0]);

  const statements = [];
  const fields = Object.keys(value);
  if (fields.length) {
    statements.push(
      env.DB.prepare(
        `UPDATE vehicles SET ${fields.map((f) => `${f} = ?`).join(', ')}
          WHERE id = ? AND user_id = ?`
      ).bind(...fields.map((f) => value[f] ?? null), params.id, user.id)
    );
  }
  if (body.is_default === true) {
    statements.push(...setDefaultStatements(env.DB, 'vehicles', user.id, params.id));
  }
  if (!statements.length) return fail('Nothing to change.');

  await env.DB.batch(statements);

  const row = await env.DB.prepare('SELECT * FROM vehicles WHERE id = ?').bind(params.id).first();
  return json({ ok: true, vehicle: shape(row) });
}

export async function onRequestDelete({ request, env, params }) {
  const user = await currentUser(request, env.DB);
  if (!user) return fail('Not signed in', 401);

  const vehicle = await owned(env.DB, user.id, params.id);
  if (!vehicle) return fail('No such vehicle', 404);

  // A vehicle on an upcoming delivery stays put. Saying so beats letting the
  // customer remove it and having the driver arrive for a car that is no
  // longer on the account.
  const live = await env.DB
    .prepare(
      `SELECT o.id, o.delivery_date FROM order_vehicles ov
         JOIN orders o ON o.id = ov.order_id
        WHERE ov.vehicle_id = ? AND o.user_id = ?
          AND o.status IN (${LIVE_ORDER_STATUSES.map(() => '?').join(',')})
        ORDER BY o.delivery_date ASC LIMIT 1`
    )
    .bind(params.id, user.id, ...LIVE_ORDER_STATUSES)
    .first();
  if (live) {
    return fail(
      `This vehicle is on a delivery scheduled for ${live.delivery_date}. ` +
      'Cancel or change that order first, then remove it.',
      409
    );
  }

  const statements = [
    env.DB.prepare(
      `UPDATE vehicles SET deleted_at = datetime('now'), is_default = 0
        WHERE id = ? AND user_id = ?`
    ).bind(params.id, user.id),
  ];

  // Removing the default promotes the next one, so the account never ends up
  // with vehicles but no default.
  if (vehicle.is_default) {
    const next = await env.DB
      .prepare(
        `SELECT id FROM vehicles
          WHERE user_id = ? AND deleted_at IS NULL AND id != ?
          ORDER BY created_at ASC LIMIT 1`
      )
      .bind(user.id, params.id)
      .first();
    if (next) statements.push(...setDefaultStatements(env.DB, 'vehicles', user.id, next.id));
  }

  await env.DB.batch(statements);
  return json({ ok: true });
}
