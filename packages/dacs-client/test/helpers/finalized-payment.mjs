import assert from 'node:assert/strict';
import { finalityCommitmentAddress } from '@kynesyslabs/dacs';

// SR-2 finalizes immediately, but its millisecond clock and the payment chain's
// seconds clock are independent. Advance the chain before mining the payment;
// waiting for wall time cannot repair a chain clock frozen at fixture startup.
export function advancePastFinalizedCommitment(h, operation) {
  const protocol = operation.state.protocol;
  assert.ok(protocol.commitment, 'payment requires a read-back seller commitment');
  const record = h.anchors.records.get(finalityCommitmentAddress(operation.terms.protocol.jobId));
  assert.ok(record, 'seller commitment must exist in the SR-2 fixture');
  assert.equal(record.receipt.state, 'finalized', 'seller commitment must be finalized before payment');
  assert.equal(record.receipt.blockRef.timestamp, protocol.commitment.committedAt);
  h.chain.advanceTo(protocol.commitment.committedAt);
}
