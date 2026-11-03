/**
 * POST /api/ops/orders/:id/status — advance a delivery.
 *
 * scheduled -> confirmed -> en_route -> delivered
 *                              |-----> no_access
 *
 * Enforced here, not just in the UI. An ops tab left open on the truck seat
 * can easily be a few states behind what actually happened.
 */

import { json, fail, requireOwner } from '../../../../_shared/lib.js';
import { nextActions } from '../[id].js';

const TIMESTAMP_COLUMN = {
  confirmed: 'confirmed_at',
  en_route: 'en_route_at',
  delivered: 'delivered_at',
};

export async function onRequestPost({ request, env, params }) {
  const who = await requireOwner(request, env.DB);
  if (who instanceof Response) return who;

  let body;
  try { body = await request.json(); } catch { return fail('Expected a JSON body'); }

  const to = body.status;
  if (!to) return fail('Expected a status');

  const order = await env.DB
    .prepare('SELECT id, status FROM orders WHERE id = ?')
    .bind(params.id)
    .first();
  if (!order) return fail('Order not found', 404);

  const allowed = nextActions(order.status);
  if (!allowed.includes(to)) {
    return fail(
      `This order is already ${order.status.replace('_', ' ')}. ` +
      (allowed.length
        ? `From here it can only move to ${allowed.join(' or ')}.`
        : `It cannot be moved any further.`),
      409
    );
  }

  const stamp = TIMESTAMP_COLUMN[to];
  const sets = ['status = ?'];
  const binds = [to];
  if (stamp) { sets.push(`${stamp} = datetime('now')`); }

  // no_access means Justin arrived and could not reach the fuel door. The
  // fee for it is still an open question with the client (Q29/Q30), so
  // nothing is charged here — the status is recorded and the decision is
  // made once the rule is settled.
  if (to === 'cancelled' || to === 'no_access') {
    sets.push(`cancelled_at = datetime('now')`);
    if (body.reason) { sets.push('cancellation_reason = ?'); binds.push(body.reason); }
  }

  binds.push(params.id);
  await env.DB.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();

  return json({ ok: true, status: to, next_actions: nextActions(to) });
}
