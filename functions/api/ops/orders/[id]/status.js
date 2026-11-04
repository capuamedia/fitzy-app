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
import { nextActions, backActions } from '../[id].js';

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
    .prepare('SELECT id, status, fuel_total_cents FROM orders WHERE id = ?')
    .bind(params.id)
    .first();
  if (!order) return fail('Order not found', 404);

  const forward = nextActions(order.status);
  const back = backActions(order.status);
  const goingBack = back.includes(to);

  if (!forward.includes(to) && !goingBack) {
    const options = [...forward, ...back];
    return fail(
      `This order is ${order.status.replace('_', ' ')}. ` +
      (options.length
        ? `From here it can only move to ${options.join(' or ')}.`
        : `It cannot be moved.`),
      409
    );
  }

  // Undoing a settled delivery throws away a money figure, so it is never
  // a single tap. The gallons on each vehicle survive — this is a
  // correction, not a retype.
  const undoingSettlement = goingBack && order.fuel_total_cents !== null;
  if (undoingSettlement && !body.confirm) {
    return json({
      needs_confirmation: true,
      message:
        'This delivery is already settled. Reopening it clears the fuel total and ' +
        'how it was paid, and you will need to settle it again. The gallons you ' +
        'entered stay put.',
    }, 409);
  }

  const sets = ['status = ?'];
  const binds = [to];

  if (goingBack) {
    // Clear the timestamp of the state being left, so the record does not
    // claim a delivery happened at a time it was undone.
    const leaving = TIMESTAMP_COLUMN[order.status];
    if (leaving) sets.push(`${leaving} = NULL`);
    sets.push(`cancelled_at = NULL`, `cancellation_reason = NULL`);
    if (undoingSettlement) {
      sets.push('fuel_total_cents = NULL', 'settlement_method = NULL',
                'fuel_rate_source_date = NULL');
    }
  } else {
    const stamp = TIMESTAMP_COLUMN[to];
    if (stamp) sets.push(`${stamp} = datetime('now')`);
  }

  // no_access means Justin arrived and could not reach the fuel door. The
  // fee for it is still an open question with the client (Q29/Q30), so
  // nothing is charged here — the status is recorded and the decision is
  // made once the rule is settled.
  if (!goingBack && (to === 'cancelled' || to === 'no_access')) {
    sets.push(`cancelled_at = datetime('now')`);
    if (body.reason) { sets.push('cancellation_reason = ?'); binds.push(body.reason); }
  }

  binds.push(params.id);
  await env.DB.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();

  return json({
    ok: true,
    status: to,
    next_actions: nextActions(to),
    back_actions: backActions(to),
    reopened: undoingSettlement,
  });
}
