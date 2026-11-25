// The verified enrollment reader as the source the seller's session admission reads: a proof that does not verify reaches
// the agent's admission as an unavailable admission, with the enrollment refusal as its cause, and admits nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { listingPin } from '../src/dacs/purchase-protocol.mjs';
import { SELLER_STATE_SIGNING_DOMAIN } from '../src/dacs/seller-durable-state.mjs';
import { openVerifiedEnrollmentReader } from '../src/devnet-demo/seller-enrollment-reader.mjs';
import { entryFor, signResponse, successEnvelope, testOnlyNodeKey, trustedNodeFor, unsignedResponse } from './helpers/enrollment-signing.mjs';
import { NODE_ENDPOINT, jsonResponse, scriptedNode } from './helpers/kit-wallet-session.mjs';
import { proposalAdmissionFixture } from './helpers/proposal-admission-fixture.mjs';
import { JOB, buyer, seller } from './helpers/protocol-fixture.mjs';

const MESSAGE = 'getParticipantEnrollmentProof';
// The scripted node answers every block above zero with this hash.
const SELECTED_BLOCK = Object.freeze({ height: 4242, blockHash: 'b'.repeat(64) });
// Node reads that put a transaction in front of the node or sign; the enrollment path makes none.
const WRITE_MESSAGES = ['execute', 'broadcastTx', 'confirmTx'];

test('a failed verified enrollment proof reaches admission as 503 with cause and no purchase effect', async (t) => {
  const f = await proposalAdmissionFixture(t);
  const node = scriptedNode();
  // The node answers with a complete signed set for the live request, signed by a key the operator did not pin.
  const asked = [];
  node.intercept = ({ call }) => {
    if (call.message !== MESSAGE) return undefined;
    const { version: _version, ...request } = call.data;
    asked.push(request.participantClaim);
    const response = signResponse(unsignedResponse({ request, observedBlock: SELECTED_BLOCK }, [entryFor(request.participantClaim)]), testOnlyNodeKey('an unpinned node key'));
    return jsonResponse(JSON.stringify(successEnvelope(response)));
  };
  const reader = openVerifiedEnrollmentReader({ endpoint: NODE_ENDPOINT, transportAuthority: 'TEST-enrollment', fetchImpl: node.fetch, claim: seller.claim,
    listingPin: listingPin(f.listing), trustedNode: trustedNodeFor(testOnlyNodeKey()) });
  t.after(() => reader.close());
  // The operator's admission reads the buyer's enrollment from the verified source on each first presentation.
  const admitted = [];
  f.admission.sessionAdmission.admit = async (query, { signal }) => {
    const entries = await reader.entriesFor(query.buyer, { sessionId: query.jobId, signal });
    admitted.push(entries);
    throw new Error('TEST the admission never gets an enrollment here');
  };
  const agent = await f.open();
  await assert.rejects(f.input(agent), (error) => {
    assert.deepEqual([error.code, error.status, error.cause?.code], ['session_admission_unavailable', 503, 'enrollment_unverified']);
    return true;
  });
  assert.deepEqual(admitted, [], 'no enrollment reached the admission');
  assert.equal(f.store.challenges.jobBinding(JOB), null, 'no presentation is accepted for the job');
  assert.deepEqual(f.signed.filter((text) => !text.startsWith(SELLER_STATE_SIGNING_DOMAIN)), [], 'the seller signed nothing but its own local state records');
  assert.deepEqual(asked, [buyer.claim], 'the buyer\'s enrollment was read from the node once');
  assert.ok(!node.calls.some((message) => WRITE_MESSAGES.includes(message)), 'nothing was sent to the node but reads');
});
