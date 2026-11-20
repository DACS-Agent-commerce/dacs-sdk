// A proposal attempt left open after the real agent kept its signed work: the wire recovers it from that work and signs nothing again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperatorBuyerAccess } from '../src/devnet-demo/buyer-access.mjs';
import { PATHS, operationOf } from './helpers/wire-routes-world.mjs';
import { AGREEMENT_SIGNATURE_PREFIX, proposalWireWorld } from './helpers/proposal-wire-world.mjs';
import { seller } from './helpers/protocol-fixture.mjs';

const buyerAccess = (openBuyerAccess) => createOperatorBuyerAccess({ custodyBuyer: seller.claim, openBuyerAccess });
const lapse = (w) => { w.state.time += w.leaseMs; };
const proposalState = (w) => operationOf(w, w.jobId, PATHS.proposals).state;

test('a proposal attempt whose agent kept its contribution is held while buyer access is closed and completes from that work once it is open, with one signature', async (t) => {
  const w = await proposalWireWorld(t);
  // The answer cannot be signed, so the attempt stays open after the agent finished.
  w.signing.failures = 2;
  assert.equal((await w.post()).status, 503);
  assert.equal(w.agreementSignatures(), 1);
  assert.equal(proposalState(w), 'pending');
  w.f.config.buyerAccess = buyerAccess(false);
  await w.restart();
  lapse(w);
  const held = await w.post();
  assert.deepEqual({ status: held.status, signed: held.signed, error: held.body.error }, { status: 503, signed: true, error: 'operation_uncertain' });
  assert.equal(proposalState(w), 'pending', 'the attempt is still open');
  w.f.config.buyerAccess = buyerAccess(true);
  await w.restart();
  lapse(w);
  const recovered = await w.post();
  assert.equal(recovered.status, 200);
  assert.equal(w.agreementSignatures(), 1, 'nothing was signed again');
  assert.equal((await w.post()).text, recovered.text, 'the completed answer is replayed');
});

test('a contribution publication cut after the signature keeps the proposal open; a refused receipt recheck holds the recovery, and the healthy retry completes with that one signature', async (t) => {
  const signatures = [];
  let cut = true;
  const w = await proposalWireWorld(t, { configure: (f) => {
    const sign = f.config.signer.sign;
    f.config.signer.sign = (bytes) => {
      const text = Buffer.from(bytes).toString();
      if (cut && text.includes('"kind":"session"') && JSON.parse(text.slice(text.indexOf('{'))).body?.session?.sellerContribution) { cut = false; throw new Error('TEST contribution publication interrupted'); }
      const signature = sign(bytes);
      if (text.startsWith(AGREEMENT_SIGNATURE_PREFIX)) signatures.push(Buffer.from(signature).toString('base64url'));
      return signature;
    };
  } });
  const first = await w.post();
  assert.deepEqual({ status: first.status, disposition: first.body.disposition }, { status: 200, disposition: 'indeterminate' }, 'the answer says the publication is not established');
  assert.equal(cut, false, 'the publication failed after the signature');
  assert.equal(signatures.length, 1);
  assert.equal(w.realAgent().retainsProposalWork(w.jobId), true);
  assert.equal(proposalState(w), 'pending');
  let verifications = 0;
  w.f.admission.verifyReceiptWith(() => ++verifications === 3 ? 'invalid' : 'valid');
  lapse(w);
  const refused = await w.post();
  assert.equal(refused.status, 503);
  assert.equal(verifications, 3, 'the restore passes before the proposal receipt recheck refuses');
  assert.equal(proposalState(w), 'pending');
  assert.equal(signatures.length, 1);
  w.f.admission.verifyReceiptWith(null);
  lapse(w);
  const complete = await w.post();
  assert.equal(complete.status, 200);
  assert.equal(signatures.length, 1);
  assert.equal(complete.body.contribution.signature.value, signatures[0], 'the answer carries the one signature');
  assert.equal((await w.post()).text, complete.text, 'the completed answer is replayed');
});
