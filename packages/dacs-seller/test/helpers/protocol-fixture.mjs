import { contentHash, deriveFixedPriceAgreement, createFixedPriceAgreementSigningPlan, createFixedPriceAgreementSignatureContribution, finalizeFixedPriceAgreementContributions, ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey, storAddress } from '@kynesyslabs/dacs';
import { fixtureListing, fixtureIdentityBundle } from '../fixtures/listings.mjs';
import { agreementInput, contributionVerifier } from '../../src/dacs/purchase-protocol.mjs';
import { anchorWriteMessage, fixtureWriteHash, FIXTURE_SUBSTRATE, FIXTURE_FINALITY } from '../../src/dacs/fixture-anchors.mjs';

export const NOW = 1_780_000_000_000, JOB = '01J8N4YV7YVYQ4DB7M8T4C7W0A';
export function testWallet(tag) {
  const seed = new Uint8Array(32).fill(tag), privateKey = privateKeyFromSeed(seed), hex = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString('hex');
  return { claim: `did:demos:agent:${hex}`, address: `0x${hex}`, signBytes: bytes => Buffer.from(ed25519Sign(bytes, privateKey)) };
}
export const buyer = testWallet(12), seller = testWallet(17);
export function fixtureRecord(logicalAddress, artifact, writer = seller, hash = contentHash(artifact)) {
  const writerSignature = writer.signBytes(Buffer.from(anchorWriteMessage(logicalAddress, hash))).toString('base64url');
  return { status: 'present', artifact, receipt: { receiptVersion: '1', substrate: FIXTURE_SUBSTRATE, finalityProfile: FIXTURE_FINALITY,
    logicalAddress, nativeAddress: storAddress(logicalAddress), contentHash: hash, writer: writer.claim,
    transactionRef: { kind: 'fixture-sr2-write', value: fixtureWriteHash({ logicalAddress, contentHash: hash, writer: writer.claim, writerSignature }) },
    state: 'finalized', observationDisposition: 'established', observedAt: NOW, blockRef: { id: 'TEST-block', height: '1', timestamp: NOW }, evidence: { kind: 'fixture-writer-signature', value: writerSignature } } };
}
export async function protocolFixture() {
  const listing = fixtureListing(seller, { now: NOW }), buyerBundle = fixtureIdentityBundle(buyer, NOW - 1000);
  const input = agreementInput({ jobId: JOB, listing, buyerBundle, generatedAt: NOW });
  const draft = deriveFixedPriceAgreement(input), plan = createFixedPriceAgreementSigningPlan(draft);
  const contributions = await Promise.all([['buyer', buyer], ['seller', seller]].map(([role, wallet]) =>
    createFixedPriceAgreementSignatureContribution(plan, role, { party: wallet.claim, algorithm: 'ed25519', sign: wallet.signBytes })));
  const agreement = await finalizeFixedPriceAgreementContributions(plan, contributions, contributionVerifier);
  return { listing, buyerBundle, input, draft, agreement, observed: { txHash: `0x${'a'.repeat(64)}`, blockNumber: 77 } };
}
