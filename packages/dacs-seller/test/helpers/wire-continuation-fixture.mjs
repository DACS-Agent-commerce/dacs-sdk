// Unshipped continuation fixture: a real durable agent commits to a deterministic SR-2 test source.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { continuationFor, retainedFor } from '../../src/dacs/seller-wire-requests.mjs';
import { listingPin } from '../../src/dacs/purchase-protocol.mjs';
import { wireBuyer } from './wire-buyer.mjs';
import assert from 'node:assert/strict';
import { contentHash } from '@kynesyslabs/dacs';
import { TP1_APPROVED_IDENTITY_RECORD, admitWireArtifact, inspectWireOperation, openWireRequestJournal } from '@kynesyslabs/dacs/wire';
import { createOrdinaryCompletionPort } from '../../src/dacs/seller-http.mjs';
import { createReservationCoordinator } from '../../src/dacs/seller-reservation-accounting.mjs';
import { boundPurchaseOf } from './bound-transport-store.mjs';
import { commitmentFixture } from './commitment-fixture.mjs';
import { NOW, seller } from './protocol-fixture.mjs';

export function receiptReader(read = () => 'valid') {
  return Object.assign(read, { chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity });
}

export async function wireContinuationFixture(t) {
  const f = await commitmentFixture(t, { publicEndpoint: 'https://seller.example.invalid' });
  const rows = new Map(), publications = [];
  const readRetained = async ({ logicalAddress }) => structuredClone(rows.get(logicalAddress) ?? { status: 'absent' });
  f.config.nativeArtifactAnchor = {
    writer: seller.claim, source: 'TEST-wire-continuation', readRetained,
    verifyReceipt: async ({ logicalAddress, artifact, receipt }) => rows.get(logicalAddress)?.receipt.contentHash === contentHash(artifact) && receipt.contentHash === contentHash(artifact) ? 'valid' : 'invalid',
    publish: async ({ logicalAddress, artifact }) => {
      assert.equal(rows.has(logicalAddress), false, 'immutable CREATE is sent once');
      publications.push(logicalAddress);
      const hash = contentHash(artifact);
      const receipt = { receiptVersion: '1', substrate: 'demos', finalityProfile: 'TEST-wire', logicalAddress,
        nativeAddress: `TEST-native-${hash.slice(0, 12)}`, contentHash: hash, writer: seller.claim,
        transactionRef: { kind: 'demos', value: hash }, state: 'finalized', observationDisposition: 'established', observedAt: NOW,
        blockRef: { id: hash, height: '1', timestamp: NOW }, evidence: { kind: 'TEST-source', value: 'fixture' }, nonce: '1' };
      rows.set(logicalAddress, { status: 'present', artifact: structuredClone(artifact), receipt, txRef: { kind: 'demos', txHash: hash, blockNumber: 1 } });
      return readRetained({ logicalAddress });
    },
  };
  const prepared = await f.prepare();
  let agent = prepared.agent;
  assert.equal((await agent.commit({ jobId: prepared.agreement.jobId })).status, 'committed');
  t.after(() => agent.close());
  const controls = { verdict: 'valid', calls: 0 };
  const readCommitmentReceipt = receiptReader((commitment) => {
    controls.calls++;
    assert.equal(contentHash(commitment.record), rows.get(commitment.anchorReceipt.logicalAddress).receipt.contentHash);
    if (controls.verdict instanceof Error) throw controls.verdict;
    return controls.verdict;
  });
  return { ...f, ...prepared, listing: f.listing, publications, controls, readCommitmentReceipt,
    agent: () => agent, reopen: async () => { agent.close(); agent = await f.open(); } };
}

export async function wireRouteFixture(t, { agent, listing, buyer, seller, store, now, readCommitmentReceipt = receiptReader(), leaseMs = 300000 }) {
  const directory = await mkdtemp(join(tmpdir(), 'TEST-wire-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidenceFor = async (path, id) => {
    if (!['/dacs/v1/payments', '/dacs/v1/bundles/request', '/dacs/v1/bundles/countersignature', '/dacs/v1/bundles/buyer-copy'].includes(path)) return {};
    const texts = agent.continuationEvidenceOf(id);
    return { commitment: Buffer.from(texts.commitmentText), agreement: Buffer.from(texts.agreementText), signedListing: Buffer.from(JSON.stringify(listing)) };
  };
  const createBuyer = () => wireBuyer({ buyer, seller, listingPin: listingPin(listing), clock: now, publicEndpoint: new URL(listing.seller.publicEndpoint).origin, readCommitmentReceipt, evidenceFor });
  const buyerWire = await createBuyer();
  const signedListing = admitWireArtifact(Buffer.from(JSON.stringify(listing)));
  const journal = openWireRequestJournal(directory, { leaseMs, clock: now });
  const { store: rawStore, capacity } = boundPurchaseOf(store);
  const reservations = createReservationCoordinator({ accounting: store.reservationAccounting, capacity, inspectOperation: (target) => inspectWireOperation(journal, target) });
  const wire = { binding: buyerWire.binding, connection: buyerWire.connection, signer: seller, store, reservations, completion: createOrdinaryCompletionPort({ journal, store: rawStore, capacity }), now, ready: () => true, requireDelegation: false,
    journal, retainedFor: input => retainedFor(agent, input),
    continuationFor: input => continuationFor(agent, input, signedListing), readCommitmentReceipt };
  return { wire, buyerWire, createBuyer };
}
