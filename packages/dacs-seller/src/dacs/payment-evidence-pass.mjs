// The kit's effect pass around the client's payment-evidence adapter. The operator's approval is asked ahead, in no pass; the
// signature and the send then run in one 'payment-evidence' pass each, with the approval hold as the kit boundary's approval
// and the caller's check as the pass's current authorization.
import { sha256Hex } from '@kynesyslabs/dacs';
import { assertKitOperationAdmitted } from '../kit-operation-guard.mjs';
import { OperationError } from '../operations.mjs';

const OPERATION_CLASS = 'payment-evidence';

function assertAuthorization(authorize) {
  if (typeof authorize !== 'function') {
    throw new OperationError('context_authorization_required', 'a payment-evidence wallet call needs its current-authorization check; nothing was asked, signed or sent');
  }
}

function assertApprovalHold(approval) {
  if (approval === null || typeof approval !== 'object' || typeof approval.revision !== 'function') {
    throw new OperationError('approval_required', 'a payment-evidence signature or send needs an approval taken before its pass; nothing was signed or sent');
  }
}

/**
 * Builds the payment-evidence pass over `runCreate` (an issued createSellerCreatePass runCreate) and `adapter` (the client's
 * payment-evidence adapter). Returns a frozen `{ approveAhead, signCreate, approveSendAhead, broadcast, readAccountNonce,
 * readTransactionState }`:
 * - `approveAhead(input, { signal, authorize })` and `approveSendAhead(retained, { signal, authorize })` ask the adapter's
 *   approval outside every pass and resolve its answer (`{ approval }`, or `{ answer }` for bytes it already holds);
 * - `signCreate(input, { signal, approval, authorize })` resolves `{ signedTransaction, txHash, nonce }` and
 *   `broadcast(retained, { signal, approval, authorize, jobId })` the adapter's send answer. Each runs the adapter's call once,
 *   in one runCreate pass on the job's lane, with `approval` (the hold) as the pass's approval and `authorize` as its
 *   current-authorization check, which the pass runs again right before the signature or each request;
 * - `readAccountNonce` and `readTransactionState` are the adapter's own reads.
 * Every effect member first checks the kit operation guard (kit_operation_guard_off), then refuses an `authorize` that is not a
 * function (`context_authorization_required`); `signCreate` and `broadcast` also refuse an `approval` without `revision()`
 * (`approval_required`). Each refusal comes before any approval, fence, signature or send. Otherwise each rejects with the
 * pass's or the adapter's own error.
 */
export function createPaymentEvidencePass({ runCreate, adapter }) {
  const passFor = (operationId, lane, authorize, approval) => ({ operationId, lane, operationClass: OPERATION_CLASS, currentAuthorization: authorize, approvalRef: approval });
  return Object.freeze({
    async approveAhead(input, { signal, authorize } = {}) {
      assertKitOperationAdmitted('paymentEvidence.approveAhead');
      assertAuthorization(authorize);
      return adapter.approveAhead(input, { signal });
    },
    async signCreate(input, { signal, approval, authorize } = {}) {
      assertKitOperationAdmitted('paymentEvidence.signCreate');
      assertAuthorization(authorize);
      assertApprovalHold(approval);
      const op = passFor(`payment-evidence-sign-${sha256Hex(input.logicalAddress)}`, `job-${input.jobId}`, authorize, approval);
      return runCreate(op, () => { signal.throwIfAborted(); return adapter.signCreate(input, { signal, approval }); });
    },
    async approveSendAhead(retained, { signal, authorize } = {}) {
      assertKitOperationAdmitted('paymentEvidence.approveSendAhead');
      assertAuthorization(authorize);
      return adapter.approveSendAhead(retained, { signal });
    },
    async broadcast(retained, { signal, approval, authorize, jobId } = {}) {
      assertKitOperationAdmitted('paymentEvidence.broadcast');
      assertAuthorization(authorize);
      assertApprovalHold(approval);
      const op = passFor(`payment-evidence-send-${retained.txHash}`, `job-${jobId}`, authorize, approval);
      return runCreate(op, () => { signal.throwIfAborted(); return adapter.broadcast(retained, { signal, approval }); });
    },
    readAccountNonce: adapter.readAccountNonce,
    readTransactionState: adapter.readTransactionState,
  });
}
