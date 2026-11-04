/**
 * Validation and normalisation for the two things a customer owns: their
 * vehicles and their addresses.
 *
 * Kept out of the route files because create and update have to agree.
 * A field that is validated on POST but not on PATCH is a field a customer
 * can set to anything on their second attempt.
 */

export const GRADES = ['87', '91', 'diesel'];
export const CLASSES = ['standard', 'large', 'motorhome'];

const GRADE_LABELS = { 87: 'Regular (87)', 91: 'Premium (91)', diesel: 'Diesel' };
export const gradeLabel = (g) => GRADE_LABELS[g] ?? g;

const str = (v, max) => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  return s ? s.slice(0, max) : null;
};

/* -------------------------------------------------------------- vehicles -- */

/**
 * A vehicle needs enough detail that a driver standing in a driveway at 6am
 * can tell which car is which, and the right grade so nobody puts 87 in a
 * car that wants 91. Everything else is optional.
 *
 * `patch` relaxes the required fields to whatever was actually sent, so a
 * PATCH that only changes the colour does not have to resend the make.
 */
export function readVehicle(body, { patch = false } = {}) {
  const out = {};
  const errors = [];
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (!patch || has('make')) {
    out.make = str(body.make, 40);
    if (!out.make) errors.push('Enter the make.');
  }
  if (!patch || has('model')) {
    out.model = str(body.model, 40);
    if (!out.model) errors.push('Enter the model.');
  }
  if (!patch || has('fuel_grade')) {
    out.fuel_grade = String(body.fuel_grade ?? '').trim();
    if (!GRADES.includes(out.fuel_grade)) errors.push('Choose a fuel type.');
  }

  if (has('year')) {
    if (body.year === null || body.year === '') out.year = null;
    else {
      const y = Number(body.year);
      // An upper bound of next year, because dealers sell ahead.
      const max = new Date().getUTCFullYear() + 1;
      if (!Number.isInteger(y) || y < 1900 || y > max) errors.push(`Year must be between 1900 and ${max}.`);
      else out.year = y;
    }
  }
  if (has('color')) out.color = str(body.color, 24);
  if (has('plate')) {
    const p = str(body.plate, 12);
    out.plate = p ? p.toUpperCase() : null;
  }
  if (has('tank_gallons')) {
    if (body.tank_gallons === null || body.tank_gallons === '') out.tank_gallons = null;
    else {
      const g = Number(body.tank_gallons);
      if (!Number.isFinite(g) || g <= 0 || g > 200) errors.push('Tank size must be between 1 and 200 gallons.');
      else out.tank_gallons = Math.round(g * 10) / 10;
    }
  }
  if (has('vehicle_class')) {
    out.vehicle_class = String(body.vehicle_class ?? 'standard').trim() || 'standard';
    if (!CLASSES.includes(out.vehicle_class)) errors.push('Unknown vehicle type.');
  }

  // A motorhome carries a fee, so the class and the grade have to agree with
  // each other rather than being two independent dropdowns.
  if (out.vehicle_class === 'motorhome' && out.fuel_grade === '91') {
    errors.push('Motorhomes take regular or diesel.');
  }

  return { value: out, errors };
}

/* ------------------------------------------------------------- locations -- */

export function readLocation(body, { patch = false } = {}) {
  const out = {};
  const errors = [];
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (!patch || has('label')) {
    out.label = str(body.label, 24);
    if (!out.label) errors.push('Give this address a name, like Home or Office.');
  }
  if (!patch || has('address_line1')) {
    out.address_line1 = str(body.address_line1, 80);
    if (!out.address_line1) errors.push('Enter the street address.');
  }
  if (!patch || has('city')) {
    out.city = str(body.city, 40);
    if (!out.city) errors.push('Enter the city.');
  }
  if (!patch || has('zip')) {
    out.zip = String(body.zip ?? '').trim();
    if (!/^\d{5}$/.test(out.zip)) errors.push('Enter a five-digit zip code.');
  }

  if (has('address_line2')) out.address_line2 = str(body.address_line2, 60);
  if (has('state')) out.state = (str(body.state, 2) || 'CA').toUpperCase();

  // Gate codes and parking notes are what make the difference between a
  // delivery that happens and one that doesn't, so they get real room.
  if (has('gate_code')) out.gate_code = str(body.gate_code, 24);
  if (has('parking_notes')) out.parking_notes = str(body.parking_notes, 400);

  return { value: out, errors };
}

/**
 * Zip to zone. This is a table lookup, not a geocode — no Maps key needed,
 * which is why addresses and pricing work before that integration exists.
 *
 * A zip that is not in the table is outside the service area. That is a
 * real answer, not a failure: the address still saves, so the business can
 * see where people are asking from.
 */
export async function resolveZone(db, zip) {
  if (!/^\d{5}$/.test(String(zip ?? ''))) return null;
  return db
    .prepare(
      `SELECT z.id, z.slug, z.name, z.monthly_price_cents, z.per_visit_cents, z.active
         FROM zone_zips zz JOIN zones z ON z.id = zz.zone_id
        WHERE zz.zip = ?`
    )
    .bind(String(zip))
    .first();
}

/**
 * Exactly one default, always.
 *
 * Two rows flagged default is worse than none: the booking screen would pick
 * whichever the database handed back first and the customer would see it
 * change between visits for no visible reason. So setting a default clears
 * the others in the same batch, and the first row a customer creates becomes
 * the default on its own.
 */
export function setDefaultStatements(db, table, userId, id) {
  return [
    db.prepare(`UPDATE ${table} SET is_default = 0 WHERE user_id = ? AND deleted_at IS NULL`).bind(userId),
    db.prepare(`UPDATE ${table} SET is_default = 1 WHERE id = ? AND user_id = ?`).bind(id, userId),
  ];
}

/**
 * Statuses that mean an order has not happened yet and still needs its rows.
 * Must match the CHECK on orders.status; 'delivered', 'cancelled' and
 * 'no_access' are finished and keep their snapshots instead.
 */
export const LIVE_ORDER_STATUSES = ['scheduled', 'confirmed', 'en_route'];
