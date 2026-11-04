/**
 * GET  /api/account/locations — the customer's addresses.
 * POST /api/account/locations — add one.
 *
 * Zone comes from the zip, as a table lookup. That is why addresses and
 * pricing both work before there is a Maps key: no geocoding is involved.
 * `lat`, `lng` and the delivery pin stay null until that integration lands.
 */

import { json, fail, currentUser, newId, centsToUsd } from '../../_shared/lib.js';
import { readLocation, resolveZone, setDefaultStatements } from '../../_shared/profile.js';

const MAX_LOCATIONS = 8;

export const shape = (row) => ({
  id: row.id,
  label: row.label,
  address_line1: row.address_line1,
  address_line2: row.address_line2,
  city: row.city,
  state: row.state,
  zip: row.zip,
  gate_code: row.gate_code,
  parking_notes: row.parking_notes,
  is_default: Boolean(row.is_default),
  one_line: [
    row.address_line1,
    row.address_line2,
    `${row.city}, ${row.state} ${row.zip}`,
  ].filter(Boolean).join(', '),
  zone: row.zone_id
    ? {
        id: row.zone_id,
        name: row.zone_name,
        monthly_price_cents: row.monthly_price_cents,
        monthly_price: centsToUsd(row.monthly_price_cents),
        per_visit_cents: row.per_visit_cents,
        per_visit: centsToUsd(row.per_visit_cents),
        active: Boolean(row.zone_active),
      }
    : null,
  // Null zone is a real answer — that zip is not served — not a missing
  // field. Every screen that offers booking has to check this.
  serviceable: Boolean(row.zone_id && row.zone_active),
});

const SELECT = `
  SELECT l.*, z.name AS zone_name, z.monthly_price_cents, z.per_visit_cents,
         z.active AS zone_active
    FROM locations l LEFT JOIN zones z ON z.id = l.zone_id`;

export async function listLocations(db, userId) {
  const { results } = await db
    .prepare(`${SELECT} WHERE l.user_id = ? AND l.deleted_at IS NULL
              ORDER BY l.is_default DESC, l.created_at ASC`)
    .bind(userId)
    .all();
  return results.map(shape);
}

export async function onRequestGet({ request, env }) {
  const user = await currentUser(request, env.DB);
  if (!user) return fail('Not signed in', 401);
  return json({ locations: await listLocations(env.DB, user.id) });
}

export async function onRequestPost({ request, env }) {
  const user = await currentUser(request, env.DB);
  if (!user) return fail('Not signed in', 401);

  let body;
  try { body = await request.json(); } catch { return fail('Expected a JSON body'); }

  const { value, errors } = readLocation(body);
  if (errors.length) return fail(errors[0]);

  const count = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM locations WHERE user_id = ? AND deleted_at IS NULL')
    .bind(user.id)
    .first();
  if (count.n >= MAX_LOCATIONS) {
    return fail(`That's the ${MAX_LOCATIONS}-address limit. Remove one first, or call us.`);
  }

  // An out-of-area zip still saves, with zone_id null. Refusing it would
  // strand someone mid-signup with no account at all; saving it means the
  // business can see where people are asking from. Booking is what checks
  // `serviceable`, not this.
  const zone = await resolveZone(env.DB, value.zip);

  const id = newId();
  const makeDefault = count.n === 0 || body.is_default === true;

  const statements = [
    env.DB.prepare(
      `INSERT INTO locations
         (id, user_id, label, address_line1, address_line2, city, state, zip,
          gate_code, parking_notes, zone_id, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).bind(
      id, user.id, value.label, value.address_line1, value.address_line2 ?? null,
      value.city, value.state ?? 'CA', value.zip,
      value.gate_code ?? null, value.parking_notes ?? null,
      zone?.id ?? null
    ),
  ];
  if (makeDefault) statements.push(...setDefaultStatements(env.DB, 'locations', user.id, id));

  await env.DB.batch(statements);

  const row = await env.DB.prepare(`${SELECT} WHERE l.id = ?`).bind(id).first();
  return json({ ok: true, location: shape(row) }, 201);
}
