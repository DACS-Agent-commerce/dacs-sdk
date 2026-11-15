// K12-H1: the kit agent's proposal admission against a presentation built by the client's own bundle builder.
// The kit's proposal fixture (reused by import) stops the agent right after admission, so a control that is admitted ends at that boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, identityBundleHash, sha256Hex, signedBytes } from '@kynesyslabs/dacs';
import { proposalAdmissionFixture } from '../../packages/dacs-seller/test/helpers/proposal-admission-fixture.mjs';
import { JOB, NOW, buyer, seller } from '../../packages/dacs-seller/test/helpers/protocol-fixture.mjs';
import { attachIdentityPresentation, buildUnsignedIdentityBundle } from '../../packages/dacs-client/src/dacs/listing.mjs';

const PRESENTATION_DOMAIN = 'dacs-bundle-presentation:v1:';
const CHALLENGE_SCOPE = sha256Hex('TEST challenge scope');
const CLOSED_REFUSAL = 'the job has no accepted context presentation';
const admissions = (fixture) => fixture.admission.calls.filter(([method]) => method === 'admit').length;

/** The client's presentation for BUYER (its own derivation), or the same presentation re-signed over `nonce`. */
function clientPresentation(nonce) {
  const built = buildUnsignedIdentityBundle({ address: buyer.address, presentedAt: NOW, sessionSeed: `${JOB}:kit-client-purchase` });
  if (nonce === undefined) return attachIdentityPresentation(built, buyer.signBytes(built.message).toString('base64url'));
  const bundle = { ...built.bundle, sessionNonce: nonce };
  const bundleHash = identityBundleHash(bundle);
  return attachIdentityPresentation({ bundle, bundleHash }, buyer.signBytes(signedBytes(PRESENTATION_DOMAIN, bundleHash)).toString('base64url'));
}

const proposalInput = (buyerIdentityBundle) => ({ proposal: {}, transportIdentity: { jobId: JOB, buyer: buyer.claim, seller: seller.claim }, buyerIdentityBundle });

test("K12-H1 today: the kit refuses a presentation carrying the client's self-derived nonce: the job has no accepted context presentation", async (t) => {
  const fixture = await proposalAdmissionFixture(t), agent = await fixture.open();
  fixture.store.challenges.issue({ jobId: JOB, buyer: buyer.claim }, CHALLENGE_SCOPE);
  await assert.rejects(agent.stagedProposal(proposalInput(clientPresentation())), (error) => {
    assert.equal(error.code, 'context_admission_closed');
    assert.equal(error.message, CLOSED_REFUSAL);
    return true;
  });
  assert.equal(admissions(fixture), 0, 'no session was opened');
});

test('K12-H1 control: the kit continues the same presentation once its context admission accepted it under a nonce the kit issued', async (t) => {
  const fixture = await proposalAdmissionFixture(t), agent = await fixture.open(), ledger = fixture.store.challenges;
  const { sessionNonce } = ledger.issue({ jobId: JOB, buyer: buyer.claim }, CHALLENGE_SCOPE), bundle = clientPresentation(sessionNonce);
  const { owner } = ledger.attempt({ path: 'context', nonce: sessionNonce, jobId: JOB, buyer: buyer.claim, challengeScopeHash: CHALLENGE_SCOPE, presentationHash: sha256Hex(canonicalize(bundle)) });
  const admission = await agent.admitSessionPresentation({ jobId: JOB, bundle, nonce: sessionNonce }), at = NOW;
  assert.equal(ledger.accept(owner, sessionNonce, { buyerBundleText: canonicalize(bundle), buyerBundleHash: identityBundleHash(bundle), admission: structuredClone(admission), admittedAt: at,
    firstAdmission: { challengeExpiresAt: ledger.retained(sessionNonce).expiresAt, generatedAt: at, checkedAt: at } }), true);
  await assert.rejects(agent.stagedProposal(proposalInput(bundle)), { code: 'proposal_not_assembled' });
  assert.equal(admissions(fixture), 1, 'the session was admitted before the fixture stopped the agent');
});
