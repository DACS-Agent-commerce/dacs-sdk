// K12-H1: the kit agent's proposal admission against a presentation built by the client's own bundle builder.
// The kit's proposal fixture (reused by import) stops the agent right after admission, so a control that is admitted ends at that boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { identityBundleHash, signedBytes } from '@kynesyslabs/dacs';
import { proposalAdmissionFixture } from '../../packages/dacs-seller/test/helpers/proposal-admission-fixture.mjs';
import { JOB, NOW, buyer, seller } from '../../packages/dacs-seller/test/helpers/protocol-fixture.mjs';
import { attachIdentityPresentation, buildUnsignedIdentityBundle } from '../../packages/dacs-client/src/dacs/listing.mjs';

const PRESENTATION_DOMAIN = 'dacs-bundle-presentation:v1:';
const NONCE_REFUSAL = 'the presentation nonce is not a challenge this seller issued';
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

test("K12-H1 today: the kit refuses a presentation carrying the client's self-derived nonce (session_not_admitted)", async (t) => {
  const fixture = await proposalAdmissionFixture(t), agent = await fixture.open();
  await agent.issueSessionChallenge({ jobId: JOB, buyer: buyer.claim });
  await assert.rejects(agent.stagedProposal(proposalInput(clientPresentation())), (error) => {
    assert.equal(error.code, 'session_not_admitted');
    assert.equal(error.message, NONCE_REFUSAL);
    return true;
  });
  assert.equal(admissions(fixture), 0, 'no session was opened');
});

test('K12-H1 control: the kit admits the same presentation when it carries a nonce the kit issued', async (t) => {
  const fixture = await proposalAdmissionFixture(t), agent = await fixture.open();
  const { sessionNonce } = await agent.issueSessionChallenge({ jobId: JOB, buyer: buyer.claim });
  await assert.rejects(agent.stagedProposal(proposalInput(clientPresentation(sessionNonce))), { code: 'proposal_not_assembled' });
  assert.equal(admissions(fixture), 1, 'the session was admitted before the fixture stopped the agent');
});
