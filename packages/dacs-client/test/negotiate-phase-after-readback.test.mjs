import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The client package holds purchase actions, so its seller agent cannot start
// and no session can be driven here. The seller package runs the same code
// (test/negotiate-phase-after-readback.test.mjs there); this pins the order of
// the client copy's source, including the recovery paths the seller copy
// reaches through commit({adopt}).
const source = readFileSync(new URL('../src/dacs/seller-agent.mjs', import.meta.url), 'utf8');

const between = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `${start} .. ${end} must be found`);
  return source.slice(from, to);
};

test('receiveProposal does not record a negotiate phase', () => {
  const body = between('async function receiveProposal(', 'function agreementState(');
  assert.doesNotMatch(body, /recordPhase\(|retainNegotiatePhase\(/);
});

test('the negotiate phase is recorded only where the Agreement has authenticated', () => {
  assert.equal(source.match(/(?<!function )retainNegotiatePhase\(/g).length, 2);
  assert.match(between('async function commit(', '// ---- DACS-4'), /if \(!early\) retainNegotiatePhase\(session, jobId\);/);
  assert.match(between('async function reconcileTransport(', 'async function payment()'), /retainNegotiatePhase\(adopted, request\.jobId, false\);/);
});

test('commit records the negotiate phase after the Agreement readback and before any commitment effect', () => {
  const body = between('async function commit(', '// ---- DACS-4');
  const readback = body.indexOf('await readBuyerAgreement(');
  const substitution = body.indexOf("'agreement_substituted'");
  const negotiate = body.indexOf('retainNegotiatePhase(session, jobId)');
  const publish = body.indexOf('await commitFixedPriceAgreement(');
  const retained = body.indexOf('session.commitment = finalized');
  const commitmentPhase = body.indexOf('retainCommitmentPhase(session, finalized)');
  assert.ok(readback >= 0 && readback < substitution && substitution < negotiate && negotiate < publish);
  assert.ok(publish < retained && retained < commitmentPhase);
});

test('the commitment adoption records the negotiate phase before the commitment phase in one save', () => {
  const body = between('async function reconcileTransport(', 'async function payment()');
  const adoption = body.indexOf('if (!session.commitment) {');
  const negotiate = body.indexOf('retainNegotiatePhase(adopted, request.jobId, false)');
  const commitmentPhase = body.indexOf('retainCommitmentPhase(adopted, adopted.commitment, false)');
  const save = body.indexOf('persist(adopted);', commitmentPhase);
  assert.ok(adoption >= 0 && adoption < negotiate && negotiate < commitmentPhase && commitmentPhase < save);
});

test('recordPhase saves only when the caller asks it to', () => {
  const body = between('function recordPhase(', 'function restore(');
  assert.equal(body.match(/persist\(session\)/g).length, 1);
  assert.match(body, /if \(write\) persist\(session\);/);
});

test('the negotiate phase entry names the Agreement address and hash', () => {
  const body = between('function retainNegotiatePhase(', 'function retainCommitmentPhase(');
  assert.match(body, /fixedPriceAgreementLogicalAddress\(jobId\)/);
  assert.match(body, /recordPhase\(session, 0, session\.proposalAdmission\.observedAt/);
});
