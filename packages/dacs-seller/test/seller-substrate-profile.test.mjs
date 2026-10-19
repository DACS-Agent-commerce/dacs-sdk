// The seller agent chooses its substrate once and fails closed: a host that
// forgets a native capability is refused at construction, never served by the
// simulated fixture substrate. No module hooks; real Listing and signer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import * as seller from '../src/index.mjs';

function sellerWorld() {
  const pair = generateKeyPairSync('ed25519'), raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  const party = { address: `0x${raw}`, claim: `did:demos:agent:${raw}` };
  const wallet = (message) => `0x${sign(null, Buffer.from(message, 'utf8'), pair.privateKey).toString('hex')}`;
  const now = Date.now(), unsigned = seller.buildUnsignedIdentityBundle({ address: party.address, presentedAt: now - 1000, sessionSeed: 'profile' });
  const draft = seller.buildListingDraft({ identityBundle: seller.attachIdentityPresentation(unsigned, wallet(unsigned.message)), displayName: 'Profile seller',
    publicEndpoint: 'https://seller.invalid/agent', listingId: 'profile-report', listingVersion: 1, title: 'Profile report', description: 'Substrate profile vectors.',
    category: 'services.market-report', tags: ['profile'], priceDem: '1', notBefore: now - 60000 });
  const listing = seller.attachListingSignature(draft, wallet(seller.listingSigningMessage(draft)));
  const unreachable = async () => { throw new Error('not reached at construction'); };
  return {
    base: { signer: { claim: party.claim, sign: (bytes) => sign(null, Buffer.from(bytes), pair.privateKey) }, listing, observeDemosTransfer: unreachable },
    agreementAnchor: { source: 'profile/agreement-readback', readAgreement: unreachable },
    artifacts: { nativeArtifactAnchor: { writer: party.claim, publish: unreachable, readRetained: unreachable, verifyReceipt: unreachable }, deliverableProducer: () => null },
    anchors: { read: unreachable, write: unreachable },
  };
}

test('without any substrate the agent is refused', async () => {
  const w = sellerWorld();
  await assert.rejects(seller.createSellerAgent(w.base), { name: 'TypeError', message: /needs agreementAnchor and nativeArtifactAnchor, or an explicit fixture substrate/ });
  await assert.rejects(seller.createSellerAgent({ ...w.base, anchors: { read: w.anchors.read } }), { name: 'TypeError', message: /explicit fixture substrate/ });
});

test('a partial native profile is refused instead of reading the fixture substrate', async () => {
  const w = sellerWorld();
  for (const options of [{ agreementAnchor: w.agreementAnchor }, w.artifacts, { agreementAnchor: w.agreementAnchor, anchors: w.anchors }, { ...w.artifacts, anchors: w.anchors }]) {
    await assert.rejects(seller.createSellerAgent({ ...w.base, ...options }), { name: 'TypeError', message: /native seller profile needs both agreementAnchor and nativeArtifactAnchor/ });
  }
});

test('the native profile takes no fixture substrate', async () => {
  const w = sellerWorld();
  await assert.rejects(seller.createSellerAgent({ ...w.base, agreementAnchor: w.agreementAnchor, ...w.artifacts, anchors: w.anchors }), { name: 'TypeError', message: /takes no fixture substrate/ });
});

test('each complete profile constructs', async () => {
  const w = sellerWorld();
  for (const options of [{ agreementAnchor: w.agreementAnchor, ...w.artifacts }, { anchors: w.anchors }]) {
    const agent = await seller.createSellerAgent({ ...w.base, ...options });
    assert.equal(agent.claim, w.base.signer.claim);
    agent.close();
  }
});
