/**
 * PATCH  /api/account/locations/:id — edit one, or make it the default.
 * DELETE /api/account/locations/:id — remove it.
 *
 * Changing the zip re-resolves the zone, because the zip is what decides
 * both whether we serve the address and what it costs.
 */

import { json, fail, currentUser } from '../../../_shared/lib.js';
import { readLocation, resolveZone, setDefaultStatements, LIVE_ORDER_STATUSES } from '../../../_shared/profile.js';
import { shape } from '../locations.js';

const SELECT = `
  SELECT l.*, z.name AS zone_name, z.monthly_price_cents, z.per_visit_cents,
         z.active AS zone_active
    FROM locations l LEFT JOIN zones z ON z.id = l.zone_id`;

export async function onRequestPatch({ request, env, params }) {
  const user = await currentUser(request, env.DB);
  if (!user) return fail('Not signed in', 401);

  const existing = await env.DB
    .prepare('SELECT * FROM locations WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(params.id, user.id)
    .first();
  if (!existing) return fail('No such address', 404);

  let body;
  try { body = await request.json(); } catch { return fail('Expected a JSON body'); }

  const { value, errors } = readLocation({ ...existing, ...body }, { patch: true });
  if (errors.length) return fail(errors[0]);

  // The zone is derived, never sent by the client. A moved address whose zip
  // changed has to be re-priced, and one that moved out of area has to stop
  // being bookable.
  if (value.zip && value.zip !== existing.zip) {
    const zone = await resolveZone(env.DB, value.zip);
    value.zone_id = zone?.id ?? null;
  }

  const statements = [];
  const fields = Object.keys(value);
  if (fields.length) {
    statements.push(
      env.DB.prepare(
        `UPDATE locations SET ${fields.map((f) => `${f} = ?`).join(', ')}
          WHERE id = ? AND user_id = ?`
      ).bind(...fields.map((f) => value[f] ?? null), params.id, user.id)
    );
  }
  if (body.is_default === true) {
    statements.push(...setDefaultStatements(env.DB, 'locations', user.id, params.id));
  }
  if (!statements.length) return fail('Nothing to change.');

  await env.DB.batch(statements);

  const row = await env.DB.prepare(`${SELECT} WHERE l.id = ?`).bind(params.id).first();
  return json({ ok: true, location: shape(row) });
}

export async function onRequestDelete({ request, env, params }) {
  const user = await currentUser(request, env.DB);
  if (!user) return fail('Not signed in', 401);

  const existing = await env.DB
    .prepare('SELECT * FROM locations WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(params.id, user.id)
    .first();
  if (!existing) return fail('No such address', 404);

  const live = await env.DB
    .prepare(
      `SELECT id, delivery_date FROM orders
        WHERE location_id = ? AND user_id = ?
          AND status IN (${LIVE_ORDER_STATUSES.map(() => '?').join(',')})
        ORDER BY delivery_date ASC LIMIT 1`
    )
    .bind(params.id, user.id, ...LIVE_ORDER_STATUSES)
    .first();
  if (live) {
    return fail(
      `We have a delivery scheduled to this address on ${live.delivery_date}. ` +
      'Cancel or move that order first, then remove it.',
      409
    );
  }

  const statements = [
    env.DB.prepare(
      `UPDATE locations SET deleted_at = datetime('now'), is_default = 0
        WHERE id = ? AND user_id = ?`
    ).bind(params.id, user.id),
  ];

  if (existing.is_default) {
    const next = await env.DB
      .prepare(
        `SELECT id FROM locations
          WHERE user_id = ? AND deleted_at IS NULL AND id != ?
          ORDER BY created_at ASC LIMIT 1`
      )
      .bind(user.id, params.id)
      .first();
    if (next) statements.push(...setDefaultStatements(env.DB, 'locations', user.id, next.id));
  }

  await env.DB.batch(statements);
  return json({ ok: true });
}
