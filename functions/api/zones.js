/**
 * GET /api/zones            — the areas we serve, with their prices.
 * GET /api/zones?zip=91360  — which area a zip falls in, if any.
 *
 * Signed in only. The zone list is ordinary marketing information, but there
 * is no reason to leave an open endpoint for scraping the whole price card.
 *
 * This is what lets the address screen answer "do you come here, and what
 * does it cost?" while someone is still typing, with no Maps key anywhere
 * in the path.
 */

import { json, fail, currentUser, centsToUsd } from '../_shared/lib.js';
import { resolveZone } from '../_shared/profile.js';

const shapeZone = (z) => ({
  id: z.id,
  slug: z.slug,
  name: z.name,
  monthly_price_cents: z.monthly_price_cents,
  monthly_price: centsToUsd(z.monthly_price_cents),
  per_visit_cents: z.per_visit_cents,
  per_visit: centsToUsd(z.per_visit_cents),
});

export async function onRequestGet({ request, env }) {
  const user = await currentUser(request, env.DB);
  if (!user) return fail('Not signed in', 401);

  const zip = new URL(request.url).searchParams.get('zip');

  if (zip) {
    if (!/^\d{5}$/.test(zip)) return fail('Enter a five-digit zip code.');
    const zone = await resolveZone(env.DB, zip);

    // Not found and found-but-paused are different answers. A zip we have
    // simply never served reads as "not yet"; one whose zone is switched off
    // is a temporary pause, and saying so avoids a customer concluding they
    // were dropped.
    if (!zone) return json({ zip, serviceable: false, reason: 'out_of_area', zone: null });
    if (!zone.active) {
      return json({ zip, serviceable: false, reason: 'paused', zone: shapeZone(zone) });
    }
    return json({ zip, serviceable: true, reason: null, zone: shapeZone(zone) });
  }

  const { results } = await env.DB
    .prepare('SELECT * FROM zones WHERE active = 1 ORDER BY sort_order ASC')
    .all();
  return json({ zones: results.map(shapeZone) });
}
