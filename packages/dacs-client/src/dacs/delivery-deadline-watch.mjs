import { purchaseStore } from '../seams/purchase-store-not-wired.mjs';
import { usesNativeAgreementPayment } from './native-agreement-payment-consumer.mjs';

export const DELIVERY_DEADLINE_SWEEP_MS = 5 * 60 * 1000;
// Inclusion normally takes 5–7 seconds, and read visibility can lag inclusion.
export const DELIVERY_DEADLINE_GRACE_MS = 2 * 60 * 1000;
export const DELIVERY_DEADLINE_STOP_MS = 10 * 1000;
export const DELIVERY_TIME_SOURCE = 'seller-recorded delivery SettlementEvidence.observedAt';
export const verifiedDelivery = (p) => p?.delivery && ['verified', 'delivery-ready', 'delivered'].includes(p.delivery.status);
const deadlineOf = (operation) => operation.state?.protocol?.agreement?.artifact?.terms?.deadline;
const validDeadline = (deadline) => Number.isSafeInteger(deadline) && deadline >= 0 && deadline <= 8640000000000000;

export function deliveryDeadlineView(operation, { now = () => Date.now(), enabled = false } = {}) {
  const p = operation.state?.protocol, stored = p?.deliveryDeadline;
  const deadline = stored?.overdue?.deadline ?? deadlineOf(operation);
  if ((!enabled && !stored) || !validDeadline(deadline)) return null;
  const pastDueMs = Math.max(0, now() - deadline), deadlineIso = new Date(deadline).toISOString();
  const prefix = `The delivery deadline was ${deadlineIso} (${Math.floor(pastDueMs / 1000)} seconds ago).`;
  const overdue = stored?.overdue, later = stored?.laterDelivery;
  let message;
  if (overdue) message = `${prefix} The host's local report at ${validDeadline(overdue.checkedAt) ? new Date(overdue.checkedAt).toISOString() : 'an unavailable historical time'} says no Deliverable from the seller was present. Demos can't prove a record is absent, so this remains a host observation, not a recorded fault. Nothing has been refunded. Do not pay again.`;
  else if (pastDueMs > 0) message = verifiedDelivery(p) ? `${prefix} Delivery is verified.` : `${prefix} Delivery is not confirmed yet. Public verify_deal reads the payment transfer only; delivery checking remains held.`;
  const deliveryMessage = later ? (!validDeadline(later.deliveredAt) ? 'The historical delivery time is unavailable.' : later.deliveredAt <= deadline
    ? `A Deliverable was verified later, and its ${later.deliveredAtSource} delivery time is within the deadline: the earlier check had not seen it yet.`
    : `A Deliverable was verified after the deadline (${later.deliveredAtSource} time ${new Date(later.deliveredAt).toISOString()}). The earlier observation stays recorded.`) : undefined;
  return { deadline, deadlineIso, pastDueMs, deliveryVerified: Boolean(verifiedDelivery(p)),
    ...(stored ?? {}), ...(message ? { message } : {}), ...(deliveryMessage ? { deliveryMessage } : {}) };
}

const defaultTimer = {
  every: (run, ms) => { const handle = setInterval(run, ms); handle.unref(); return handle; }, cancel: clearInterval,
  after: (run, ms) => setTimeout(run, ms), cancelAfter: clearTimeout,
};

export function createDeliveryDeadlineWatch({ db, ops, coordinates, enabled = false, now = () => Date.now(), logger, timer = defaultTimer, store }) {
  const { transaction } = purchaseStore(store);
  let handle = null, stopped = false, running = null, cursor = '', checkDelivery;
  // Select a bounded page of plausible rows; all authority gates are repeated
  // in memory, and again inside the observation transaction.
  const candidates = enabled ? db.prepare(`SELECT id,account_id FROM operations
    WHERE kind='purchase' AND status='settled_verified' AND id > ?
      AND json_extract(terms, '$.protocol') IS NOT NULL
      AND json_extract(state, '$.protocol.stage') = 'payment-evidenced'
      AND json_extract(state, '$.protocol.agreement.hash') IS NOT NULL
      AND json_extract(state, '$.protocol.commitment.verifiedAt') IS NOT NULL
      AND json_extract(state, '$.protocol.deliveryDeadline.overdue') IS NULL
      AND COALESCE(json_extract(state, '$.protocol.delivery.status'), '') NOT IN ('verified','delivery-ready','delivered')
      AND json_type(state, '$.protocol.agreement.artifact.terms.deadline') = 'integer'
      AND json_extract(state, '$.protocol.agreement.artifact.terms.deadline') < ?
    ORDER BY id LIMIT 10`) : null;
  // Only the stage where advance() itself reads delivery: an earlier or
  // refused stage must not skip its claim and payment-evidence steps. Native
  // profiles have no delivery reader here, so they are skipped, not retried.
  const eligible = (operation) => {
    const p = operation?.state?.protocol, deadline = deadlineOf(operation ?? {});
    const seller = p?.agreement?.artifact?.parties?.find((party) => party.role === 'seller')?.primaryClaim;
    return operation?.kind === 'purchase' && operation.status === 'settled_verified' && p?.stage === 'payment-evidenced' && !usesNativeAgreementPayment(operation) && coordinates.get(operation.id)?.verifiedAt
      && operation.terms.protocol && p?.agreement?.hash && p.agreement.ref?.contentHash === p.agreement.hash && p.commitment?.verifiedAt
      && seller === operation.terms.seller.claim && p.agreement.terms?.seller === seller
      && p.agreement.terms?.deadline === deadline && validDeadline(deadline);
  };
  function observe(operation, readback) {
    if (!enabled || stopped || !readback?.notPresent || readback.delivery?.status !== 'absent') return operation;
    return transaction(db, () => {
      const current = ops.get(operation.accountId, operation.id), p = current?.state?.protocol;
      const deadline = deadlineOf(current ?? {}), checkedAt = readback.checkedAt, clock = now();
      if (!eligible(current) || p.deliveryDeadline?.overdue || verifiedDelivery(p)
        || p.agreement.hash !== operation.state.protocol.agreement.hash
        || !validDeadline(clock) || !validDeadline(checkedAt) || checkedAt > clock
        || checkedAt <= deadline + DELIVERY_DEADLINE_GRACE_MS) return current ?? operation;
      const overdue = { deadline, checkedAt, read: 'not-present', disposition: 'indeterminate', obligatedParty: 'seller',
        seller: p.agreement.terms.seller, authority: 'local-observation', source: 'host-supplied' };
      return ops.transition(current.id, current.status, current.status, { state: { protocol: { ...p, deliveryDeadline: { overdue } } },
        event: 'protocol_delivery_deadline_overdue', data: overdue });
    });
  }
  async function pass() {
    let rows = candidates.all(cursor, now() - DELIVERY_DEADLINE_GRACE_MS);
    if (!rows.length && cursor) { cursor = ''; rows = candidates.all(cursor, now() - DELIVERY_DEADLINE_GRACE_MS); }
    for (const row of rows) {
      if (stopped) break;
      cursor = row.id;
      try {
        const operation = ops.get(row.account_id, row.id);
        if (eligible(operation) && !verifiedDelivery(operation.state.protocol) && !operation.state.protocol.deliveryDeadline?.overdue) {
          await checkDelivery(operation, { shouldSave: () => !stopped });
        }
      } catch {
        logger?.warn('delivery_deadline_purchase_check_failed', { operationId: row.id });
      }
    }
  }
  function sweep() {
    if (!enabled || stopped || !checkDelivery) return Promise.resolve();
    if (running) return running;
    running = pass().finally(() => { running = null; });
    return running;
  }
  function start() {
    if (!enabled || stopped || handle !== null) return;
    const run = () => sweep().catch(() => logger?.warn('delivery_deadline_sweep_failed'));
    handle = timer.every(run, DELIVERY_DEADLINE_SWEEP_MS);
    return run();
  }
  async function stop() {
    stopped = true;
    if (handle !== null) { timer.cancel(handle); handle = null; }
    if (!running) return;
    const after = timer.after?.bind(timer) ?? defaultTimer.after, cancelAfter = timer.cancelAfter?.bind(timer) ?? defaultTimer.cancelAfter;
    let timeout;
    try { await Promise.race([running.catch(() => {}), new Promise((resolve) => { timeout = after(resolve, DELIVERY_DEADLINE_STOP_MS); })]); }
    finally { cancelAfter(timeout); }
  }
  return { observe, sweep, start, stop, setDeliveryCheck: (check) => { checkDelivery = check; } };
}
