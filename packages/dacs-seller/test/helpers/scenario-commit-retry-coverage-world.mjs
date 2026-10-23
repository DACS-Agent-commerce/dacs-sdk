// Shared NODE-only offline world for the C5/C6 commit retry interaction
// coverage. The actual createSellerAgent runs with test-owned ephemeral
// Ed25519 keys, a scripted native FinalityCommitmentRecord capability and a
// scripted native Agreement reader. With `http`, the buyer side of the SDK
// exchange and every later command go through the actual buyer client,
// client/server peer authentication, durable transport store and seller HTTP
// handler, invoked in-process with a synthetic loopback request (no socket).
// The mutation loader writes a source copy only under the private TMPDIR.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { canonicalize, logicalToStorageProgramName, fixedPriceAgreementLogicalAddress, contentHash, generateCanonicalJobId, sha256Hex } from '@kynesyslabs/dacs';
import { createSellerAgent } from '../../src/dacs/seller-agent.mjs';
import { createSellerDurableState } from '../../src/dacs/seller-durable-state.mjs';
import { createNativePaymentEvidenceConsumer } from '../../src/dacs/native-payment-evidence-consumer.mjs';
import { createSellerHttpHandler, createSellerAgentClient } from '../../src/dacs/seller-http.mjs';
import { createSellerTransportStore, createSellerTransportServerAuth, createSellerTransportClientAuth } from '../../src/dacs/seller-transport-auth.mjs';
import { buildUnsignedIdentityBundle, attachIdentityPresentation } from '../../src/dacs/listing.mjs';
import { planAgreement, exchangeAgreement, listingPin } from '../../src/dacs/purchase-protocol.mjs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../../src/dacs/wallet-transactions.mjs';
import { createEphemeralWallet } from '../fixtures/wallet.mjs';
import { fixtureListing } from '../fixtures/listings.mjs';

export const clone = (value) => JSON.parse(JSON.stringify(value));
const TX = 'a1'.repeat(32), BLOCK = 'b2'.repeat(32);

const privateDirectory = (t, prefix) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};

// A synthetic loopback fetch into the actual handler: the real client signs the
// request and verifies the signed response; nothing leaves this process.
function inProcessFetch(handle) {
  return async (url, init) => {
    const req = Readable.from([Buffer.from(init.body)]);
    Object.assign(req, { url: new URL(url).pathname, method: init.method, headers: { ...init.headers },
      socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' } });
    const res = { destroyed: false, writableEnded: false, headersSent: false, status: 0, headers: {}, text: '',
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
      end(text) { this.text = String(text); this.writableEnded = true; } };
    await handle(req, res);
    return new Response(res.text, { status: res.status, headers: res.headers });
  };
}

export async function commitWorld(t, { create = createSellerAgent, nativeEvidence = false, http = false, commitOnSignature = false, fixedClock = false } = {}) {
  const directory = privateDirectory(t, 'scenario-commit-retry-');
  const seller = createEphemeralWallet(), buyer = createEphemeralWallet(), clock = Date.now();
  const listing = fixtureListing(seller, { listingId: 'commit-retry-coverage', price: '1', now: clock });
  const durableDirectory = join(directory, 'seller');
  const effects = { commitmentSignatures: 0, publish: 0, readRetained: 0, verify: 0, agreementReads: 0, anchorEvidence: 0, fetch: 0, commitRoute: 0, reconcile: 0 };
  // `stored` is the one applied CREATE; `view` rewrites only a fresh
  // observation. `lostPublishResponse` applies the CREATE, then leaves the
  // observer indeterminate and reports no wallet answer.
  const native = { stored: null, view: (value) => value, verdict: 'valid', status: null, lostPublishResponse: false };
  const nativeArtifactAnchor = {
    writer: seller.claim,
    publish: async ({ logicalAddress, artifact, artifactKind }) => {
      effects.publish++;
      assert.equal(artifactKind, 'FinalityCommitmentRecord');
      const receipt = { receiptVersion: '1', substrate: 'TEST-offline-demos-sr2', finalityProfile: 'TEST-one-node-not-finality', logicalAddress,
        nativeAddress: `TEST-native-${sha256Hex(logicalAddress).slice(0, 16)}`, contentHash: contentHash(artifact), transactionRef: { kind: 'demos-tx', value: TX },
        writer: seller.claim, nonce: '7', state: 'finalized', observationDisposition: 'established', observedAt: clock + 1000,
        evidence: { kind: 'demos-tx', value: TX }, blockRef: { id: BLOCK, height: '9', timestamp: clock + 1000 } };
      native.stored = { artifact: clone(artifact), receipt, txRef: { kind: 'demos', txHash: TX, blockNumber: 9 }, signedProjection: { TEST: 'public signed projection' } };
      if (native.lostPublishResponse) { native.status = 'indeterminate'; return { status: 'indeterminate', reason: 'TEST applied CREATE, wallet answer lost' }; }
      return { status: 'present', ...clone(native.stored) };
    },
    readRetained: async ({ artifactKind }) => {
      effects.readRetained++;
      assert.equal(artifactKind, 'FinalityCommitmentRecord');
      if (native.status) return { status: native.status, reason: `TEST ${native.status} readback` };
      if (!native.stored) return { status: 'absent', reason: 'TEST no CREATE' };
      return { status: 'present', ...native.view(clone(native.stored)) };
    },
    verifyReceipt: async () => { effects.verify++; return native.verdict; },
  };
  let agreement = null;
  const agreements = new Map();
  const agreementStatus = { disposition: 'present', blockNumber: 8 };
  const agreementAnchor = {
    source: 'TEST-offline-native-agreement',
    readAgreement: async ({ logicalAddress, writer, agreementHash }) => {
      effects.agreementReads++;
      if (agreementStatus.disposition !== 'present') return { disposition: agreementStatus.disposition, reason: 'TEST Agreement read held' };
      const agreement = agreements.get(logicalAddress);
      if (!agreement || writer !== buyer.claim || contentHash(agreement) !== agreementHash) return { disposition: 'absent', reason: 'TEST no Agreement' };
      return { disposition: 'present', artifact: clone(agreement), ref: { anchor: { kind: 'storage-program', locator: logicalAddress }, contentHash: agreementHash },
        native: { source: 'TEST-offline-native-agreement', evidenceMode: 'TEST-scripted', nativeAddress: 'TEST-native-agreement', txRef: { kind: 'demos', txHash: 'c3'.repeat(32), blockNumber: agreementStatus.blockNumber } } };
    },
  };
  // Constructed real capability; its observer fetch is refused in-process.
  const evidence = nativeEvidence ? createNativePaymentEvidenceConsumer({ rpcUrl: 'http://127.0.0.1:9/',
    anchorEvidence: async () => { effects.anchorEvidence++; throw new Error('TEST evidence anchoring is out of scope'); },
    fetchImpl: async () => { effects.fetch++; throw new Error('TEST no network'); } }) : null;
  const refusedAnchors = { read: async () => { throw new Error('TEST fixture substrate is not used'); }, write: async () => { throw new Error('TEST fixture substrate write forbidden'); } };
  const signer = { claim: seller.claim, sign: (bytes) => { if (bytes.toString().startsWith('dacs-finality-commitment:v1:')) effects.commitmentSignatures++; return seller.signBytes(bytes); } };
  const buildOptions = { signer, listing, ...(fixedClock ? { now: () => clock } : {}), commitOnSignature, anchors: refusedAnchors,
    observeDemosTransfer: async () => ({ status: 'unavailable', reason: 'TEST payment observation not in scope' }), durableDirectory, agreementAnchor,
    nativeArtifactAnchor, deliverableProducer: () => { throw new Error('TEST delivery not in scope'); }, ...(evidence ? { nativePaymentEvidence: evidence } : {}) };
  const build = () => create(buildOptions);
  let agent = await build();
  t.after(() => agent?.close());
  const jobId = generateCanonicalJobId();
  const unsigned = buildUnsignedIdentityBundle({ address: buyer.address, presentedAt: clock, sessionSeed: 'scenario-commit-retry-buyer' });
  const buyerBundle = attachIdentityPresentation(unsigned, buyer.signHex(unsigned.message));
  const planned = planAgreement({ jobId, listing, buyerBundle, generatedAt: clock });
  let client = null, store = null;
  if (http) {
    // `http: 'legacy'` is the supported unauthenticated loopback mode, where
    // every command performs the route (no reservation or reconciliation).
    let authentication = null;
    if (http !== 'legacy') {
      const peer = privateDirectory(t, 'scenario-commit-retry-peer-');
      store = createSellerTransportStore({ path: join(peer, 'peer.sqlite') });
      t.after(() => store.close());
      authentication = createSellerTransportServerAuth({ sellerSigner: signer, listingPin: listingPin(listing), store });
    }
    // Late-bound facade: the handler always reaches the current (restarted) agent.
    const facade = { claim: seller.claim, listingPin: listingPin(listing),
      receiveProposal: (body) => agent.receiveProposal(body), agreementState: (identity) => agent.agreementState(identity),
      commit: (body) => { effects.commitRoute++; return agent.commit(body); },
      commitOnSignature: (body) => agent.commitOnSignature(body),
      reconcileTransport: (input) => { effects.reconcile++; return agent.reconcileTransport(input); } };
    const handle = createSellerHttpHandler(facade, { ...(authentication ? { authentication } : {}), commitOnSignature });
    // The test peer can always attempt the early route; the seller decides.
    client = createSellerAgentClient({ url: 'http://127.0.0.1:1', fetchImpl: inProcessFetch(handle), commitOnSignature: true,
      ...(authentication ? { authentication: createSellerTransportClientAuth({ buyerSigner: { claim: buyer.claim, sign: (bytes) => buyer.signBytes(bytes) }, seller: seller.claim,
        resolveJob: () => ({ listingPin: listingPin(listing), agreementHash: planned.plan.agreementHash }) }) } : {}) });
  }
  const sellerSide = client
    ? { propose: (input) => client.propose(input), agreementState: (identity) => client.agreementState(identity) }
    : { propose: (input) => agent.receiveProposal(input), agreementState: (identity) => agent.agreementState(identity) };
  await exchangeAgreement({ plan: planned.plan, draft: planned.draft, buyerClaim: buyer.claim, buyerBundle,
    agreementSignature: buyer.signHex(planned.agreementMessage), anchorSignature: buyer.signHex(planned.anchorMessage),
    seller: sellerSide, anchors: refusedAnchors,
    anchorAdapter: {
      anchorAgreement: async (input) => { agreement = clone(input.artifact); agreements.set(input.logicalAddress, agreement); return { disposition: 'submitted' }; },
      reconcileAgreementAnchor: async () => (agreement ? { disposition: 'indeterminate', reason: 'TEST capture only' } : { disposition: 'absent', reason: 'TEST not yet captured' }),
      verifyAnchorReceipt: () => 'indeterminate',
    } });
  assert.ok(agreement, 'actual SDK exchange produced the finalized two-party Agreement');
  assert.equal(contentHash(agreement), planned.plan.agreementHash);
  const newAgreement = async () => {
    const nextJob = generateCanonicalJobId();
    const next = planAgreement({ jobId: nextJob, listing, buyerBundle, generatedAt: clock });
    const exchange = await exchangeAgreement({ plan: next.plan, draft: next.draft, buyerClaim: buyer.claim, buyerBundle,
      agreementSignature: buyer.signHex(next.agreementMessage), anchorSignature: buyer.signHex(next.anchorMessage), seller: sellerSide, anchors: refusedAnchors,
      anchorAdapter: { anchorAgreement: async input => { agreements.set(input.logicalAddress, clone(input.artifact)); return { disposition: 'submitted' }; },
        reconcileAgreementAnchor: async () => agreements.has(fixedPriceAgreementLogicalAddress(nextJob)) ? { disposition: 'indeterminate', reason: 'TEST capture only' } : { disposition: 'absent', reason: 'TEST not captured' }, verifyAnchorReceipt: () => 'indeterminate' } });
    const artifact = agreements.get(fixedPriceAgreementLogicalAddress(nextJob));
    assert.ok(artifact, JSON.stringify(exchange));
    return { jobId: nextJob, agreement: artifact, signedProjection: authorizedCreate({ buyer, agreement: artifact, clock }) };
  };
  const retained = async () => { agent.close(); const state = await createSellerDurableState({ dir: durableDirectory, signer, listingPin: listingPin(listing) });
    try { return clone(state.loadSession(jobId)); } finally { state.close(); agent = await build(); } };
  const transport = (path = '/dacs/v1/commitments', body = { jobId }) => { const rawBody = Buffer.from(JSON.stringify(body));
    return { request: { method: 'POST', path, jobId, seller: seller.claim, buyer: buyer.claim, listingPin: agent.listingPin, agreementHash: planned.plan.agreementHash, bodyHash: sha256Hex(rawBody) }, body, rawBody }; };
  return { newAgreement, get agent() { return agent; }, seller, buyer, jobId, native, effects, retained, transport, client, store, clock, agreement: clone(agreement), signedProjection: authorizedCreate({ buyer, agreement, clock }), agreementStatus, buildOptions };
}

// Repeatable wrong-implementation witness: the exact current seller-agent
// source with one asserted unique substitution, imported from the private
// TMPDIR with its imports pinned to the same module instances.
export async function mutantCreateSellerAgent(t, replacements) {
  const sourceUrl = new URL('../../src/dacs/seller-agent.mjs', import.meta.url);
  let source = readFileSync(sourceUrl, 'utf8');
  for (const [from, to] of replacements) {
    assert.equal(source.split(from).length, 2, `mutation anchor must occur exactly once: ${from}`);
    source = source.replace(from, () => to);
  }
  source = source.replace(/from '(\.{1,2}\/[^']+)'/g, (_, relative) => `from '${new URL(relative, sourceUrl).href}'`)
    .replace(/from '@kynesyslabs\/dacs'/g, () => `from '${import.meta.resolve('@kynesyslabs/dacs')}'`);
  const file = join(privateDirectory(t, 'scenario-commit-retry-mutant-'), 'seller-agent-mutant.mjs');
  writeFileSync(file, source, { mode: 0o600 });
  return (await import(pathToFileURL(file).href)).createSellerAgent;
}

// Buyer-authorized public CREATE evidence; no fixture broadcast or readback.
export function authorizedCreate({ buyer, agreement, clock }) {
  const logicalAddress = fixedPriceAgreementLogicalAddress(agreement.jobId), programName = logicalToStorageProgramName(logicalAddress);
  const tx = buildStorageProgramCreatePayload({ from: buyer.address, storageAddress: deriveStorageAddress(buyer.address, programName, 1), programName,
    logicalAddress, signedListing: clone(agreement), nonce: 1, timestamp: clock });
  tx.content.from_ed25519_address = buyer.address;
  tx.content.data[1].metadata = { logicalAddress, artifactKind: 'Agreement', contentHash: contentHash(agreement), envelopeHash: sha256Hex(canonicalize(agreement)) };
  tx.hash = sha256Hex(JSON.stringify(tx.content));
  tx.signature = { type: 'ed25519', data: buyer.signHex(tx.hash) };
  return tx;
}
