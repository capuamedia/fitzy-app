/**
 * GET  /api/account/vehicles — the customer's vehicles.
 * POST /api/account/vehicles — add one.
 *
 * Every query is scoped by the session's user id. A customer's own vehicle
 * list is the kind of thing that leaks by accident when a route trusts an
 * id from the request instead of the cookie.
 */

import { json, fail, currentUser, newId, getSettings, centsToUsd } from '../../_shared/lib.js';
import { readVehicle, gradeLabel, setDefaultStatements } from '../../_shared/profile.js';

const MAX_VEHICLES = 12;

export const shape = (row) => ({
  id: row.id,
  year: row.year,
  make: row.make,
  model: row.model,
  color: row.color,
  plate: row.plate,
  fuel_grade: row.fuel_grade,
  fuel_label: gradeLabel(row.fuel_grade),
  tank_gallons: row.tank_gallons,
  vehicle_class: row.vehicle_class,
  is_default: Boolean(row.is_default),
  // What the driver reads on the job card.
  display: [row.year, row.color, row.make, row.model].filter(Boolean).join(' '),
});

export async function listVehicles(db, userId) {
  const { results } = await db
    .prepare(
      `SELECT * FROM vehicles
        WHERE user_id = ? AND deleted_at IS NULL
        ORDER BY is_default DESC, created_at ASC`
    )
    .bind(userId)
    .all();
  return results.map(shape);
}

export async function onRequestGet({ request, env }) {
  const user = await currentUser(request, env.DB);
  if (!user) return fail('Not signed in', 401);

  const settings = await getSettings(env.DB, [
    'vehicles_included_per_visit', 'extra_vehicle_cents', 'motorhome_fee_cents',
  ]);

  return json({
    vehicles: await listVehicles(env.DB, user.id),
    // The fee rules the screen explains, read from settings rather than
    // written into the page, so changing a price changes the copy too.
    fees: {
      included_per_visit: Number(settings.vehicles_included_per_visit),
      extra_vehicle_cents: Number(settings.extra_vehicle_cents),
      extra_vehicle: centsToUsd(Number(settings.extra_vehicle_cents)),
      motorhome_fee_cents: Number(settings.motorhome_fee_cents),
      motorhome_fee: centsToUsd(Number(settings.motorhome_fee_cents)),
    },
  });
}

export async function onRequestPost({ request, env }) {
  const user = await currentUser(request, env.DB);
  if (!user) return fail('Not signed in', 401);

  let body;
  try { body = await request.json(); } catch { return fail('Expected a JSON body'); }

  const { value, errors } = readVehicle(body);
  if (errors.length) return fail(errors[0]);

  const count = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM vehicles WHERE user_id = ? AND deleted_at IS NULL')
    .bind(user.id)
    .first();
  if (count.n >= MAX_VEHICLES) {
    return fail(`That's the ${MAX_VEHICLES}-vehicle limit. Remove one first, or call us.`);
  }

  const id = newId();
  // The first vehicle is the default without being asked. Nobody wants a
  // "set as default" decision when there is only one option.
  const makeDefault = count.n === 0 || body.is_default === true;

  const statements = [
    env.DB.prepare(
      `INSERT INTO vehicles
         (id, user_id, year, make, model, color, plate, fuel_grade, tank_gallons, vehicle_class, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).bind(
      id, user.id,
      value.year ?? null, value.make, value.model,
      value.color ?? null, value.plate ?? null,
      value.fuel_grade, value.tank_gallons ?? null,
      value.vehicle_class ?? 'standard'
    ),
  ];
  if (makeDefault) statements.push(...setDefaultStatements(env.DB, 'vehicles', user.id, id));

  await env.DB.batch(statements);

  const row = await env.DB.prepare('SELECT * FROM vehicles WHERE id = ?').bind(id).first();
  return json({ ok: true, vehicle: shape(row) }, 201);
}
