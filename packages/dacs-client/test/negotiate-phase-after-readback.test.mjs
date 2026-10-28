import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The client package holds purchase actions, so its seller agent cannot start
// and no session can be driven here. The seller package runs the same code
// (test/negotiate-phase-after-readback.test.mjs there); this pins the order of
// the client copy's source.
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

test('the negotiate phase is recorded once, from commit', () => {
  assert.equal(source.match(/(?<!function )retainNegotiatePhase\(/g).length, 1);
  assert.match(between('async function commit(', '// ---- DACS-4'), /retainNegotiatePhase\(session, jobId\)/);
});

test('commit records the negotiate phase after the Agreement readback and before the commitment is retained', () => {
  const body = between('async function commit(', '// ---- DACS-4');
  const readback = body.indexOf('await readBuyerAgreement(');
  const substitution = body.indexOf("'agreement_substituted'");
  const negotiate = body.indexOf('retainNegotiatePhase(session, jobId)');
  const retained = body.indexOf('session.commitment = finalized');
  const commitmentPhase = body.indexOf('retainCommitmentPhase(session, finalized)');
  assert.ok(readback >= 0 && readback < substitution && substitution < negotiate && negotiate < retained && retained < commitmentPhase);
});

test('the negotiate phase entry names the Agreement address and hash', () => {
  const body = between('function retainNegotiatePhase(', 'function retainCommitmentPhase(');
  assert.match(body, /fixedPriceAgreementLogicalAddress\(jobId\)/);
  assert.match(body, /recordPhase\(session, 0, session\.proposalAdmission\.observedAt/);
});
