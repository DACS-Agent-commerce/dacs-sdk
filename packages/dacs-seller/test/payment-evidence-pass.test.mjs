// The kit's payment-evidence pass: a call without its current-authorization check, or a signature or send without an approval
// hold taken before the pass, is refused before any fence, approval or wallet call; a complete call runs in one runCreate pass.
import test from 'node:test';
import assert from 'node:assert/strict';

const { createPaymentEvidencePass } = await import('../src/dacs/payment-evidence-pass.mjs');

const MEMBERS = ['approveAhead', 'signCreate', 'approveSendAhead', 'broadcast', 'readAccountNonce', 'readTransactionState'];
const INPUT = Object.freeze({ logicalAddress: 'dacs4:payment:TEST-job-a:demos-native:DEM:2', jobId: 'TEST-job-a' });
const RETAINED = Object.freeze({ signedTransaction: '{}', txHash: 'a'.repeat(64) });
const HOLD = Object.freeze({ revision: () => 'TEST-revision', release: async () => {} });

// A pass over a runCreate that records each op and runs its work, and an adapter whose six members count their calls.
function countedPass() {
  const calls = Object.fromEntries([...MEMBERS, 'runCreate'].map((name) => [name, 0]));
  const ops = [];
  const adapter = Object.fromEntries(MEMBERS.map((name) => [name, async () => { calls[name]++; return { TEST: name }; }]));
  const runCreate = async (op, work) => { calls.runCreate++; ops.push(op); return work(); };
  return { pass: createPaymentEvidencePass({ runCreate, adapter }), calls, ops };
}

test('a payment-evidence pass call without its authorization check, or a signature or send without an approval hold, is refused before any fence, approval or wallet call', async () => {
  const { pass, calls, ops } = countedPass();
  const signal = new AbortController().signal, authorize = () => true;
  const withoutCheck = [() => pass.approveAhead(INPUT, { signal }), () => pass.signCreate(INPUT, { signal, approval: HOLD }),
    () => pass.approveSendAhead(RETAINED, { signal }), () => pass.broadcast(RETAINED, { signal, approval: HOLD, jobId: INPUT.jobId })];
  for (const call of withoutCheck) await assert.rejects(call(), { code: 'context_authorization_required' });
  for (const approval of [undefined, null, {}, { revision: 'TEST-not-a-function' }]) {
    await assert.rejects(pass.signCreate(INPUT, { signal, approval, authorize }), { code: 'approval_required' });
    await assert.rejects(pass.broadcast(RETAINED, { signal, approval, authorize, jobId: INPUT.jobId }), { code: 'approval_required' });
  }
  assert.deepEqual(Object.values(calls), Array(MEMBERS.length + 1).fill(0), 'no runCreate and no adapter member was called');

  assert.deepEqual(await pass.signCreate(INPUT, { signal, approval: HOLD, authorize }), { TEST: 'signCreate' });
  assert.equal(calls.runCreate, 1, 'the signature ran in one pass');
  assert.equal(ops[0].approvalRef, HOLD, 'the hold is the pass\'s approval');
  assert.equal(ops[0].currentAuthorization, authorize, 'the caller\'s check is the pass\'s current authorization');
  assert.deepEqual({ operationClass: ops[0].operationClass, lane: ops[0].lane }, { operationClass: 'payment-evidence', lane: `job-${INPUT.jobId}` });
});
