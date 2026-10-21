// Source-aware OFFLINE bridge evidence, not independent review or consensus.
// The real packaged SDK/wallet uses the unchanged plugin relay. A test-owned
// wire fixture independently verifies each signature, nonce and complete debit.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as shipped from '../src/dacs/demos-sr2-wallet-bridge.mjs';
import { createSdkWalletSession } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { decodeDemosAnchorReceiptProof, createFixedPriceAgreementSigningPlan, createFixedPriceAgreementSignatureContribution, finalizeFixedPriceAgreementContributions, generateCanonicalJobId, contentHash, isPayeeBoundAgreementDocument, signedBytes, isListing } from '@kynesyslabs/dacs';
import { startHarness } from './helpers/harness.mjs';
import { startAnchorFixture, anchorRequest, FIXTURE_IDENTITY } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';
import { buildUnsignedIdentityBundle, attachIdentityPresentation, verifyComponent } from '../src/dacs/listing.mjs';
import { planAgreement } from '../src/dacs/purchase-protocol.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { fixtureListing } from './fixtures/listings.mjs';
import { canonicalSignature } from '../src/dacs/fixture-anchors.mjs';
import { addressForClaim, verifyDemosSignature } from '../src/wallet/demos-signature.mjs';
import { buildStorageProgramCreatePayload, communityProgramName, deriveStorageAddress } from '../src/dacs/wallet-transactions.mjs';

installLoopbackOnlyGuard();
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const { Demos, Identities, validateMnemonic } = await import('../public/portal/embedded-wallet/demos-runtime.mjs');
const clone = (v) => structuredClone(v);
const digest = (v) => createHash('sha256').update(v).digest('hex');
const claim = (address) => `did:demos:agent:${address.slice(2)}`;
const logical = 'dacs3:agreement:offline-sr2-job';
const value = () => ({ artifactType: 'Agreement', jobId: 'offline-sr2-job', signatures: [{ opaque: 'scope-carrier' }], terms: { amount: '2.5', currency: 'DEM' } });
const jcs = (v) => v === null || typeof v !== 'object' ? JSON.stringify(typeof v === 'string' ? v.normalize('NFC') : v)
  : Array.isArray(v) ? `[${v.map(jcs).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`).join(',')}}`;

// Durable public-data journal witness: atomic replacement + file fsync. The
// shared lock is process-local; cross-process locking remains an integration
// requirement, not a claim made by this test-owned single-process store.
const fileLocks = new Map();
async function fileLock(id, work) {
  const previous = fileLocks.get(id) ?? Promise.resolve();
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  fileLocks.set(id, next);
  await previous;
  try { return await work(); } finally { release(); if (fileLocks.get(id) === next) fileLocks.delete(id); }
}
function fileJournal(path, transform = (_, record) => record) {
  async function entries() { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } }
  return {
    entries,
    async get(key) { return clone(new Map(await entries()).get(key)); },
    put: (key, record) => fileLock(`${path}:atomic-put`, async () => {
      const records = new Map(await entries());
      records.set(key, transform(key, clone(record)));
      const temp = `${path}.pending`;
      const handle = await open(temp, 'w', 0o600);
      try { await handle.writeFile(JSON.stringify([...records])); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, path);
    }),
    withWalletLock: (key, work) => fileLock(`${path}:${key}`, work),
  };
}

// Read observations are constructed independently from accepted wire data;
// no SDK evidence/address/receipt helper is used by this fixture. Deliberate
// Demos execution projections turn integers into strings and fill edit txhash.
async function observedFixture() {
  const wire = await startAnchorFixture();
  const faults = { marker: true, unavailable: false, native: null, tx: null, block: null, genesis: FIXTURE_IDENTITY, ambiguous: false };
  const reads = [];
  const native = (tx) => { const op = tx.content.data[1]; return { success: true, storageAddress: tx.content.to, owner: tx.content.from,
    programName: op.programName, data: clone(op.data), metadata: clone(op.metadata), createdByTx: tx.hash, interactionTxs: [tx.hash] }; };
  const server = http.createServer(async (req, res) => {
    const send = (status, body, marker = faults.marker) => { res.writeHead(status, { 'content-type': 'application/json', connection: 'close', ...(marker ? { 'x-dacs-simulation': 'fixture' } : {}) }); res.end(JSON.stringify(body)); };
    const envelope = (response) => ({ result: 200, response, require_reply: false, extra: null });
    try {
      if (req.method === 'GET') {
        reads.push(req.url);
        if (faults.unavailable) return send(503, { simulated: true });
        if (faults.ambiguous && req.url === `/storage-program/stor-${'a'.repeat(40)}` && wire.record.accepted.length) return send(200, { ...native(wire.record.accepted[0]), storageAddress: `stor-${'a'.repeat(40)}` });
        const tx = wire.record.accepted.find((x) => `/storage-program/${x.content.to}` === req.url);
        if (!tx) return send(404, { simulated: true });
        return send(200, faults.native ? faults.native(native(tx)) : native(tx));
      }
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      const call = body.params?.[0];
      if (body.method === 'nodeCall' && ['getBlockByNumber', 'getTxByHash', 'searchStoragePrograms'].includes(call.message)) {
        reads.push(call.message);
        if (faults.unavailable) return send(503, { simulated: true });
        if (call.message === 'searchStoragePrograms') {
          let rows = wire.record.accepted.map((tx) => native(tx)).filter((n) => n.programName === call.data.query).map((n) => ({ storageAddress: n.storageAddress, programName: n.programName }));
          if (faults.ambiguous && rows.length) rows.push({ ...rows[0], storageAddress: `stor-${'a'.repeat(40)}` });
          return send(200, envelope(rows.slice(call.data.options.offset, call.data.options.offset + call.data.options.limit)));
        }
        if (call.message === 'getTxByHash') {
          const index = wire.record.accepted.findIndex((x) => x.hash === call.data.hash);
          if (index < 0) return send(200, envelope(null));
          const tx = clone(wire.record.accepted[index]);
          tx.status = 'confirmed'; tx.blockNumber = index + 1;
          for (const k of ['amount', 'nonce', 'timestamp']) tx.content[k] = String(tx.content[k]);
          for (const k of ['network_fee', 'rpc_fee', 'additional_fee']) tx.content.transaction_fee[k] = String(tx.content.transaction_fee[k]);
          for (const e of tx.content.gcr_edits) { if (Object.hasOwn(e, 'amount')) e.amount = String(e.amount); if (e.txhash === '') e.txhash = tx.hash; }
          return send(200, envelope(faults.tx ? faults.tx(tx) : tx));
        }
        if (call.data.blockNumber === 0) return send(200, envelope({ number: 0, status: 'confirmed', hash: faults.genesis }));
        const number = call.data.blockNumber;
        const tx = wire.record.accepted[number - 1];
        const block = { number, status: 'confirmed', hash: digest(`test-block:${number}`), content: { timestamp: 1791144000 + number,
          ordered_transactions: tx ? [tx.hash] : [] }, validation_data: { simulated: true, chainIdentity: FIXTURE_IDENTITY, fixtureValidator: 'no-real-consensus' } };
        return send(200, envelope(faults.block ? faults.block(block) : block));
      }
      const response = await fetch(wire.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
      return send(response.status, await response.json(), response.headers.get('x-dacs-simulation') === 'fixture');
    } catch { return send(500, { error: 'test fixture unavailable' }); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, wire, faults, reads,
    close: async () => { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); await wire.close(); } };
}

async function setup(t, { module = shipped, walletApi = { createSdkWalletSession }, decide = () => true, transform, profile = 'simulated-loopback' } = {}) {
  const chain = await observedFixture();
  const h = await startHarness({ chain, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
  t.after(() => h.close());
  const dir = await mkdtemp(join(tmpdir(), 'dacs-sr2-bridge-'));
  t.after(() => rm(dir, { recursive: true }));
  const path = join(dir, 'public-journal.json');
  const journal = fileJournal(path, transform);
  const approvals = [];
  const network = h.config.chain.network;
  let tick = 1791144000000;
  const factory = ({ anchorJournal }) => walletApi.createSdkWalletSession({ DemosCtor: Demos, IdentitiesCtor: Identities, validateMnemonic, anchorJournal,
    transactionTransport: { profile, network, rpcUrl: `${h.origin}/portal/api/wallet-rpc` },
    approve: async (r) => { approvals.push(clone(r)); return decide(r); } });
  const bridge = module.createDemosSr2WalletBridge({ rpcUrl: chain.url, network, journal, walletFactory: factory, now: () => tick++ });
  const account = await bridge.wallet.create();
  t.after(() => bridge.wallet.lock());
  const input = { logicalAddress: logical, artifact: value(), writer: claim(account.address) };
  return { bridge, input, account, approvals, chain, h, network, journal, path, factory };
}
const laneRecord = async (w) => (await w.journal.entries()).find(([k]) => k.startsWith('sr2/wallet/'))?.[1];

// Produce the ACTUAL SDK payee-bound Agreement, including two independently
// verified role contributions. Buyer signatures use the real packaged wallet;
// seller is a distinct fresh test key. No injected artifactType or fake sigs.
// sellerPrefix searches generatedAt for a seller signature whose canonical
// base64url starts with it, verified by the SDK-form verifier only.
async function realAgreement(w, { nonAscii = false, sellerPrefix } = {}) {
  const seller = createEphemeralWallet();
  assert.notEqual(seller.address, w.account.address);
  const now = 1791144000000;
  const listing = fixtureListing(seller, { now });
  const unsigned = buildUnsignedIdentityBundle({ address: w.account.address, presentedAt: now, sessionSeed: 'actual-sdk-agreement' });
  const presentation = await w.bridge.wallet.request({ method: 'sign', params: [unsigned.message] });
  assert.equal(presentation.success, true);
  const buyerBundle = attachIdentityPresentation(unsigned, presentation.data.signature);
  const jobId = generateCanonicalJobId({ timestamp: now });
  let generatedAt = now;
  while (sellerPrefix && !seller.signBytes(Buffer.from(planAgreement({ jobId, listing, buyerBundle, generatedAt }).agreementMessage, 'utf8')).toString('base64url').startsWith(sellerPrefix)) {
    assert.ok(++generatedAt < now + 1_000_000, `no ${sellerPrefix} seller signature found`);
  }
  const derived = planAgreement({ jobId, listing, buyerBundle, generatedAt });
  const draft = clone(derived.draft);
  if (nonAscii) draft.terms.additionalTerms = { note: 'café' };
  const plan = createFixedPriceAgreementSigningPlan(draft);
  const buyer = await createFixedPriceAgreementSignatureContribution(plan, 'buyer', { party: w.input.writer, algorithm: 'ed25519', sign: async (bytes) => {
    const answer = await w.bridge.wallet.request({ method: 'sign', params: [Buffer.from(bytes).toString('utf8')] });
    assert.equal(answer.success, true);
    return canonicalSignature(answer.data.signature);
  } });
  const sellerContribution = await createFixedPriceAgreementSignatureContribution(plan, 'seller', { party: seller.claim, algorithm: 'ed25519', sign: seller.signBytes });
  const artifact = await finalizeFixedPriceAgreementContributions(plan, [buyer, sellerContribution], (s) => (sellerPrefix
    ? verifyComponent({ signedBytes: s.signedBytes, signature: { algorithm: s.algorithm, signer: s.party, value: s.value } })
    : verifyDemosSignature({ address: addressForClaim(s.party), message: Buffer.from(s.signedBytes).toString('utf8'), signature: s.value })) ? 'valid' : 'invalid');
  assert.equal(isPayeeBoundAgreementDocument(artifact), true);
  assert.equal(Object.hasOwn(artifact, 'artifactType'), false);
  return { artifact, artifactKind: 'Agreement', logicalAddress: derived.anchorAddress, writer: w.input.writer, jobId, plan, seller, buyerBundle };
}

test('legacy Listing CREATE keeps its dacs1 name and one-field metadata; actual packaged wallet accepts without generic Agreement unhold', async (t) => {
  const w = await setup(t);
  const a = await realAgreement(w);
  const draft = fixtureListing(a.seller, { now: 1791144000000 });
  delete draft.signature;
  draft.seller.identity = a.buyerBundle;
  const answer = await w.bridge.wallet.request({ method: 'sign', params: [Buffer.from(signedBytes('dacs-listing:v1:', contentHash(draft))).toString('utf8')] });
  assert.equal(answer.success, true);
  const listing = { ...draft, signature: { algorithm: 'ed25519', signer: w.input.writer, value: canonicalSignature(answer.data.signature) } };
  assert.equal(isListing(listing), true);
  const address = 'dacs1:listing:legacy-kind-control:1';
  const name = communityProgramName(address);
  const payload = buildStorageProgramCreatePayload({ from: w.account.address, storageAddress: deriveStorageAddress(w.account.address, name, 1), programName: name,
    logicalAddress: address, signedListing: listing, nonce: 1, timestamp: 1791144000000 });
  const result = await w.bridge.wallet.request({ method: 'sendTransaction', params: [payload] });
  assert.equal(result.success, true, JSON.stringify(result));
  const stored = w.chain.wire.record.accepted[0].content.data[1];
  assert.match(stored.programName, /^dacs1-/);
  assert.deepEqual(stored.metadata, { logicalAddress: address });
  assert.equal(w.approvals.filter((r) => r.method === 'sendTransaction').length, 1);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
});

test('actual two-party SDK Agreement bytes remain unchanged; explicit kind is signed into CREATE and owner-bound receipt readback', async (t) => {
  const w = await setup(t);
  const a = await realAgreement(w);
  const original = jcs(a.artifact);
  const independentlyExpectedScope = digest(jcs(Object.fromEntries(Object.entries(a.artifact).filter(([k]) => !['signature', 'signatures'].includes(k)))));
  assert.equal(independentlyExpectedScope, a.plan.agreementHash);
  const out = await w.bridge.anchor(a);
  assert.equal(out.status, 'simulated-read-visible', JSON.stringify(out));
  assert.equal(out.artifactKind, 'Agreement');
  assert.equal(jcs(out.artifact), original);
  assert.deepEqual(out.artifact.signatures, a.artifact.signatures);
  assert.equal(Object.hasOwn(out.artifact, 'artifactType'), false);
  assert.equal(out.receipt.contentHash, independentlyExpectedScope);
  assert.equal(contentHash(out.artifact), independentlyExpectedScope);
  const tx = w.chain.wire.record.accepted[0];
  assert.equal(jcs(tx.content.data[1].data), original);
  assert.equal(tx.content.data[1].metadata.artifactKind, 'Agreement');
  assert.equal(tx.content.data[1].metadata.envelopeHash, digest(original));
  assert.equal(tx.hash, digest(JSON.stringify(tx.content)), 'kind metadata is inside exact signed transaction bytes');
  const approval = w.approvals.find((r) => r.method === 'sendTransaction');
  assert.equal(approval.content.artifactKind, 'Agreement');
  assert.equal(approval.content.jobId, a.jobId);
  assert.equal(approval.content.exactStorageBytes, original);
  assert.equal(JSON.parse(approval.content.exactCreate).metadata.artifactKind, 'Agreement');
  assert.equal((await w.bridge.read(a.logicalAddress, { expectedWriter: a.writer, expectedArtifactKind: 'Agreement' })).artifactKind, 'Agreement');
  await assert.rejects(w.bridge.read(a.logicalAddress, { expectedWriter: a.writer, expectedArtifactKind: 'SettlementEvidence' }), (e) => e.code === 'invalid');
  assert.equal(await w.bridge.verifyReceipt({ receipt: out.receipt, logicalAddress: a.logicalAddress, artifact: a.artifact, expectedWriter: a.writer, artifactKind: 'Agreement' }), 'valid');
  assert.equal(await w.bridge.verifyReceipt({ receipt: out.receipt, logicalAddress: a.logicalAddress, artifact: a.artifact, expectedWriter: a.writer, artifactKind: 'SettlementEvidence' }), 'invalid');
  assert.equal((await w.bridge.anchor(a)).status, 'simulated-read-visible');
  assert.equal(w.approvals.filter((r) => r.method === 'sendTransaction').length, 1);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  w.chain.faults.native = (n) => ({ ...n, metadata: { ...n.metadata, artifactKind: 'SettlementEvidence' } });
  // Node-side tampering is not a receipt; it is not established, never a
  // writer-signed contradiction (the source change).
  assert.equal((await w.bridge.resume(a)).status, 'indeterminate', 'independent native kind tampering is not a receipt');
  assert.deepEqual(externalAttempts, []);
});

test('actual Agreement whose seller base64url signature starts with 0x anchors unchanged through the bridge with one approval and send', async (t) => {
  const w = await setup(t);
  const a = await realAgreement(w, { sellerPrefix: '0x' });
  assert.match(a.artifact.signatures.find((s) => s.party === a.seller.claim).value, /^0x[A-Za-z0-9_-]{84}$/);
  const original = jcs(a.artifact);
  const out = await w.bridge.anchor(a);
  assert.equal(out.status, 'simulated-read-visible', JSON.stringify(out));
  assert.equal(jcs(out.artifact), original, 'the signature value is anchored exactly as signed');
  assert.equal(jcs(w.chain.wire.record.accepted[0].content.data[1].data), original);
  assert.equal(await w.bridge.verifyReceipt({ receipt: out.receipt, logicalAddress: a.logicalAddress, artifact: a.artifact, expectedWriter: a.writer, artifactKind: 'Agreement' }), 'valid');
  assert.equal(w.approvals.filter((r) => r.method === 'sendTransaction').length, 1);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  assert.deepEqual(externalAttempts, []);
});

test('actual Agreement missing/mismatched kind, job, signed bytes, owner or DEM rail fail before storage approval/broadcast', async (t) => {
  const w = await setup(t);
  const a = await realAgreement(w);
  const noKind = { ...a }; delete noKind.artifactKind;
  const altered = clone(a.artifact); altered.terms.price.amount = '3';
  const wrongRail = clone(a.artifact); wrongRail.terms.rail = { railId: 'other:DEM', railVersion: 1 };
  for (const input of [noKind, { ...a, artifactKind: 'SettlementEvidence' }, { ...a, artifactKind: 'Unknown' }, { ...a, jobId: generateCanonicalJobId() },
    { ...a, artifact: altered }, { ...a, artifact: wrongRail }, { ...a, writer: a.seller.claim }]) {
    await assert.rejects(w.bridge.anchor(input), (e) => e.code === 'invalid');
  }
  assert.equal(w.approvals.filter((r) => r.method === 'sendTransaction').length, 0);
  assert.equal(w.chain.wire.record.calls.length, 0);
  const correct = anchorRequest(w.account.address, w.network, a);
  const variants = [
    (r) => { delete r.artifactKind; },
    (r) => { r.artifactKind = 'SettlementEvidence'; },
    (r) => { r.transaction.content.data[1].metadata.artifactKind = 'SettlementEvidence'; },
    (r) => { delete r.transaction.content.data[1].metadata.artifactKind; },
    (r) => { r.jobId = generateCanonicalJobId(); },
    (r) => { r.transaction.content.data[1].data = altered; r.contentHash = digest(jcs(Object.fromEntries(Object.entries(altered).filter(([k]) => k !== 'signatures')))); r.envelopeHash = digest(jcs(altered)); r.transaction.content.data[1].metadata.contentHash = r.contentHash; r.transaction.content.data[1].metadata.envelopeHash = r.envelopeHash; },
  ];
  for (const mutate of variants) {
    const request = clone(correct); mutate(request);
    const answer = await w.bridge.wallet.request({ method: 'sendTransaction', params: [request] });
    assert.equal(answer.success, false); assert.equal(answer.error.code, 'invalid_params');
  }
  const generic = await w.bridge.wallet.request({ method: 'sendTransaction', params: [correct.transaction] });
  assert.equal(generic.success, false); assert.equal(generic.error.code, 'invalid_params');
  assert.equal(w.chain.wire.record.calls.length, 0);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
});

test('actual Agreement non-ASCII SDK mismatch remains held; unknown apply can only reconcile the same retained kind/bytes', async (t) => {
  const unicode = await setup(t);
  const u = await realAgreement(unicode, { nonAscii: true });
  await assert.rejects(unicode.bridge.anchor(u), (e) => e.code === 'non-ascii-held');
  const wireRequest = anchorRequest(unicode.account.address, unicode.network, u);
  const answer = await unicode.bridge.wallet.request({ method: 'sendTransaction', params: [wireRequest] });
  assert.equal(answer.success, false); assert.equal(answer.error.code, 'payload_mismatch');
  assert.equal(unicode.chain.wire.record.confirms.length, 0); assert.equal(unicode.chain.wire.record.broadcastAttempts.length, 0);
  const w = await setup(t);
  const a = await realAgreement(w);
  w.chain.wire.faults.dropAfterApply = true;
  assert.equal((await w.bridge.anchor(a)).code, 'outcome_unknown');
  await assert.rejects(w.bridge.resume({ ...a, artifactKind: 'SettlementEvidence' }), (e) => e.code === 'invalid');
  w.chain.faults.unavailable = true;
  assert.equal((await w.bridge.resume(a)).status, 'indeterminate');
  w.chain.faults.unavailable = false;
  assert.equal((await w.bridge.resume(a)).status, 'simulated-read-visible');
  assert.equal(w.approvals.filter((r) => r.method === 'sendTransaction').length, 1);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
});

test('kind-binding guard witness uses unchanged valid SDK Agreement bytes and retains an accepting control', async (t) => {
  const url = new URL('../public/portal/embedded-wallet/sdk-provider.mjs', import.meta.url);
  const before = '(explicitKind && op.metadata.artifactKind !== r.artifactKind)';
  const source = readFileSync(url, 'utf8');
  // Two sites: storageAnchorPlan (this loopback path; replace() mutates the
  // first) and devnetAgreementAnchorPlan (the devnet Agreement transport).
  assert.equal(source.split(before).length, 3);
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(source.replace(before, 'false')).toString('base64')}`);
  const control = await setup(t, { walletApi: mutant });
  const c = await realAgreement(control);
  assert.equal((await control.bridge.anchor(c)).status, 'simulated-read-visible');
  for (const [walletApi, accepts] of [[{ createSdkWalletSession }, false], [mutant, true]]) {
    const w = await setup(t, { walletApi });
    const a = await realAgreement(w);
    const request = anchorRequest(w.account.address, w.network, a);
    request.transaction.content.data[1].metadata.artifactKind = 'SettlementEvidence';
    const original = jcs(a.artifact);
    const result = await w.bridge.wallet.request({ method: 'sendTransaction', params: [request] });
    assert.equal(result.success, accepts);
    assert.equal(w.chain.wire.record.broadcastAttempts.length, accepts ? 1 : 0);
    if (accepts) { assert.equal(jcs(w.chain.wire.record.accepted[0].content.data[1].data), original); assert.equal(w.approvals.at(-1).content.artifactKind, 'Agreement'); }
    else assert.equal(result.error.code, 'invalid_params');
  }
  assert.deepEqual(externalAttempts, []);
});

test('actual approved wallet wraps Agreement CREATE; projection, independent writer/native/scope and durable owner-bound readback', async (t) => {
  const w = await setup(t);
  const out = await w.bridge.anchor(w.input);
  assert.equal(out.status, 'simulated-read-visible', JSON.stringify(out));
  assert.equal(out.evidenceMode, 'simulated-fixture');
  assert.match(out.finality, /no-real-consensus/);
  assert.equal(w.approvals.length, 1);
  assert.equal(out.receipt.contentHash, digest('{"artifactType":"Agreement","jobId":"offline-sr2-job","terms":{"amount":"2.5","currency":"DEM"}}'));
  const envelopeHash = digest(jcs(w.input.artifact));
  const nativeAddress = `stor-${digest(`${w.account.address}:${logical.replaceAll(':', '%3A')}:1:`).slice(0, 40)}`;
  assert.equal(out.receipt.nativeAddress, nativeAddress);
  assert.equal(out.receipt.writer, w.input.writer);
  const signed = w.chain.wire.record.accepted[0];
  assert.equal(signed.hash, digest(JSON.stringify(signed.content)));
  assert.equal(signed.content.data[1].metadata.envelopeHash, envelopeHash);
  assert.equal(signed.content.gcr_edits.length, 4, 'actual SDK signed edits, not skeleton');
  assert.equal(w.approvals[0].content.exactStorageBytes, jcs(w.input.artifact));
  assert.equal(w.approvals[0].content.debit.totalOs, '7000000000');
  const proof = decodeDemosAnchorReceiptProof(out.receipt);
  assert.equal(proof.chainIdentity, FIXTURE_IDENTITY);
  assert.equal(JSON.parse(out.demosEvidence.signedTransaction).content.nonce, 1, 'retained original, not string-projected executed transaction');
  assert.equal((await laneRecord(w)).stage, 'broadcast-accepted');
  assert.equal(await w.bridge.verifyReceipt({ receipt: out.receipt, logicalAddress: logical, artifact: w.input.artifact, expectedWriter: w.input.writer }), 'valid');
  assert.ok(w.chain.reads.filter((r) => r.startsWith('/storage-program/')).length >= 4, 'one fixture read is insufficient to release lane');
  const again = await w.bridge.anchor(w.input);
  assert.equal(again.status, 'simulated-read-visible');
  assert.equal(w.approvals.length, 1);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  const seller = await setup(t);
  assert.notEqual(seller.account.address, w.account.address);
  await assert.rejects(seller.bridge.anchor(w.input), (e) => e.code === 'wrong-writer');
  assert.equal((await seller.bridge.anchor({ ...seller.input, logicalAddress: 'dacs3:seller-evidence:offline-sr2-job' })).status, 'simulated-read-visible');
  assert.equal(seller.chain.wire.record.accepted[0].content.from, seller.account.address);
  assert.deepEqual(externalAttempts, []);
});

test('unknown apply outcome survives disk journal reopening; replay only observes and never asks approval or resends', async (t) => {
  const w = await setup(t);
  w.chain.wire.faults.dropAfterApply = true;
  const first = await w.bridge.anchor(w.input);
  assert.equal(first.status, 'indeterminate');
  assert.equal(first.code, 'outcome_unknown');
  assert.equal((await laneRecord(w)).stage, 'broadcast-started');
  assert.equal(w.chain.wire.record.accepted.length, 1);
  w.chain.faults.unavailable = true;
  const reopened = shipped.createDemosSr2WalletBridge({ rpcUrl: w.chain.url, network: w.network, journal: fileJournal(w.path), walletFactory: () => w.bridge.wallet });
  assert.equal((await reopened.resume(w.input)).status, 'indeterminate');
  assert.equal((await reopened.anchor(w.input)).status, 'indeterminate');
  const blocked = await w.bridge.wallet.request({ method: 'sendTransaction', params: [{ to: w.account.address, amount: '1' }] });
  assert.equal(blocked.error.code, 'outcome_unknown', 'shared lane also fences other wallet writes');
  w.chain.faults.unavailable = false;
  assert.equal((await reopened.resume(w.input)).status, 'simulated-read-visible');
  assert.equal((await laneRecord(w)).stage, 'broadcast-accepted');
  assert.equal(w.approvals.length, 1);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
});

// the source change: every fault here is a node answer that does not authenticate (native
// readback, transaction signature or executed content, block inclusion), so it
// is not established: never a receipt, never a contradiction, lane kept.
test('native receipt, membership, writer, logical/native address and signed projection failures never release pending lane', async (t) => {
  const variants = [
    ['missing native', (c) => { c.faults.native = () => ({ success: false }); }, 'indeterminate'],
    ['changed value', (c) => { c.faults.native = (n) => ({ ...n, data: { ...n.data, jobId: 'altered' } }); }, 'indeterminate'],
    ['wrong logical', (c) => { c.faults.native = (n) => ({ ...n, metadata: { ...n.metadata, logicalAddress: 'other' } }); }, 'indeterminate'],
    ['wrong native', (c) => { c.faults.native = (n) => ({ ...n, storageAddress: `stor-${'f'.repeat(40)}` }); }, 'indeterminate'],
    ['wrong owner', (c) => { c.faults.native = (n) => ({ ...n, owner: `0x${'f'.repeat(64)}` }); }, 'indeterminate'],
    ['missing signature', (c) => { c.faults.tx = (x) => ({ ...x, signature: null }); }, 'indeterminate'],
    ['changed executed scope', (c) => { c.faults.tx = (x) => ({ ...x, content: { ...x.content, network: 'wrong' } }); }, 'indeterminate'],
    ['missing membership', (c) => { c.faults.block = (b) => ({ ...b, content: { ...b.content, ordered_transactions: [] } }); }, 'indeterminate'],
    ['wrong chain receipt', (c) => { c.faults.block = (b) => ({ ...b, validation_data: { ...b.validation_data, chainIdentity: 'f'.repeat(64) } }); }, 'indeterminate'],
    ['ambiguous owned native reads', (c) => { c.faults.ambiguous = true; }, 'indeterminate'],
    ['unmarked response', (c) => { c.faults.marker = false; }, 'indeterminate'],
  ];
  for (const [label, fault, status] of variants) await t.test(label, async (s) => {
    const w = await setup(s, { decide: () => { fault(w.chain); return true; } });
    const out = await w.bridge.anchor(w.input);
    assert.equal(out.status, status, JSON.stringify(out));
    assert.equal(out.receipt, undefined);
    assert.equal((await laneRecord(w)).stage, 'sr2-readback-pending');
    assert.equal((await w.bridge.anchor(w.input)).status, status);
    assert.equal(w.approvals.length, 1);
    assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  });
});

test('approval, approved-signature journal and persistence are required; profile, content scope and size holds remain exact', async (t) => {
  const declined = await setup(t, { decide: () => false });
  assert.equal((await declined.bridge.anchor(declined.input)).code, 'user_rejected');
  assert.equal((await declined.bridge.anchor(declined.input)).code, 'authorization-required');
  assert.equal(declined.approvals.length, 1);
  assert.equal(declined.chain.wire.record.broadcastAttempts.length, 0);
  const lost = await setup(t, { transform: (key, record) => key.startsWith('sr2/wallet/') && record.stage === 'sr2-readback-pending'
    ? { ...record, signedTransaction: { ...record.signedTransaction, signature: null } } : record });
  assert.equal((await lost.bridge.anchor(lost.input)).status, 'indeterminate', 'journal non-retention is fenced');
  assert.equal((await lost.bridge.resume(lost.input)).code, 'authorization-required');
  assert.equal(lost.chain.wire.record.broadcastAttempts.length, 1);
  const badStore = await setup(t, { transform: (key, record) => key.startsWith('sr2/adapter/') ? { ...record, stage: 'not-retained' } : record });
  await assert.rejects(badStore.bridge.anchor(badStore.input), (e) => e.code === 'journal-error');
  assert.equal(badStore.chain.wire.record.broadcastAttempts.length, 0);
  assert.throws(() => shipped.createDemosSr2WalletBridge({ rpcUrl: 'http://127.0.0.1:9', network: 'offline', walletFactory: () => ({}) }), (e) => e.code === 'journal-required');
  const held = await setup(t, { profile: 'testnet-held' });
  await assert.rejects(held.bridge.anchor(held.input), (e) => e.code === 'profile-held');
  assert.deepEqual(held.chain.wire.record.calls, []);
  assert.deepEqual(held.chain.reads, []);
  const w = await setup(t);
  await assert.rejects(w.bridge.anchor({ ...w.input, artifact: { ...w.input.artifact, note: 'café' } }), (e) => e.code === 'non-ascii-held');
  await assert.rejects(w.bridge.anchor({ ...w.input, artifact: { ...w.input.artifact, note: 'a'.repeat(24 * 1024) } }), (e) => e.code === 'artifact-bound');
  await assert.rejects(w.bridge.anchor({ ...w.input, receiptContentHash: 'f'.repeat(64) }), (e) => e.code === 'hash-profile-held');
  assert.equal((await w.bridge.anchor(w.input)).status, 'simulated-read-visible');
  await assert.rejects(w.bridge.anchor({ ...w.input, artifact: { ...w.input.artifact, terms: { amount: '3', currency: 'DEM' } } }), (e) => e.code === 'conflict');
  const forged = clone((await w.bridge.read(logical, { expectedWriter: w.input.writer })).receipt);
  forged.nativeAddress = `stor-${'f'.repeat(40)}`;
  assert.equal(await w.bridge.verifyReceipt({ receipt: forged, logicalAddress: logical, artifact: w.input.artifact, expectedWriter: w.input.writer }), 'invalid');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
});

test('exact 24 KiB ASCII boundary accepts, one byte beyond holds, stale approval and concurrent replay cannot duplicate a write', async (t) => {
  const w = await setup(t);
  const bounded = { ...w.input.artifact, note: '' };
  bounded.note = 'a'.repeat(24 * 1024 - Buffer.byteLength(jcs(bounded)));
  assert.equal(Buffer.byteLength(jcs(bounded)), 24 * 1024);
  await assert.rejects(w.bridge.anchor({ ...w.input, artifact: { ...bounded, note: bounded.note + 'a' } }), (e) => e.code === 'artifact-bound');
  const outcomes = await Promise.allSettled(Array.from({ length: 3 }, () => w.bridge.anchor({ ...w.input, artifact: bounded })));
  assert.equal(outcomes.filter((o) => o.status === 'fulfilled' && o.value.status === 'simulated-read-visible').length, 1);
  assert.equal(outcomes.filter((o) => o.status === 'rejected' && o.reason.code === 'handoff-already-issued').length, 2);
  assert.equal(w.approvals.length, 1);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  const stale = await setup(t, { decide: () => { stale.chain.wire.setNonce(stale.account.address, 1); return true; } });
  const out = await stale.bridge.anchor(stale.input);
  assert.equal(out.status, 'rejected');
  assert.equal(out.code, 'stale_plan');
  assert.equal((await stale.bridge.anchor(stale.input)).code, 'authorization-required');
  assert.equal(stale.approvals.length, 1);
  assert.equal(stale.chain.wire.record.broadcastAttempts.length, 0);
});

async function projectionMutant() {
  const adapterUrl = new URL('../src/dacs/demos-sr2-adapter.mjs', import.meta.url);
  const target = 'embedded && !demosTransactionContentMatches(signed.content, c, txHash)';
  let source = readFileSync(adapterUrl, 'utf8');
  assert.equal(source.split(target).length, 2);
  const absolutize = (text, url) => text.replace(/from '([^']+)'/g, (_, s) => `from '${s.startsWith('.') ? new URL(s, url).href : import.meta.resolve(s)}'`);
  const adapter = `data:text/javascript;base64,${Buffer.from(absolutize(source.replace(target, 'false'), adapterUrl)).toString('base64')}`;
  const bridgeUrl = new URL('../src/dacs/demos-sr2-wallet-bridge.mjs', import.meta.url);
  const bridge = absolutize(readFileSync(bridgeUrl, 'utf8').replace("from './demos-sr2-adapter.mjs'", `from '${adapter}'`), bridgeUrl);
  return import(`data:text/javascript;base64,${Buffer.from(bridge).toString('base64')}`);
}

test('repeatable projection guard witness retains accepting control and exposes changed executed network', async (t) => {
  const mutant = await projectionMutant();
  const control = await setup(t, { module: mutant });
  assert.equal((await control.bridge.anchor(control.input)).status, 'simulated-read-visible');
  // The node's executed content differs from the signed projection: not
  // established on the shipped adapter (the source change), wrongly accepted by the mutant.
  for (const [module, expected] of [[shipped, 'indeterminate'], [mutant, 'simulated-read-visible']]) {
    const w = await setup(t, { module, decide: () => { w.chain.faults.tx = (tx) => ({ ...tx, content: { ...tx.content, network: 'unapproved-network' } }); return true; } });
    assert.equal((await w.bridge.anchor(w.input)).status, expected);
    assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  }
  assert.deepEqual(externalAttempts, []);
});

// the source change (re-review r3, code P3-3): another chain identity is node or pin data,
// not the record. A resume that observes it is indeterminate, never rejected,
// and the lane is read back only.
test('a bridge resume that observes another chain identity is indeterminate and sends nothing again', async (t) => {
  const w = await setup(t);
  const a = await realAgreement(w);
  assert.equal((await w.bridge.anchor(a)).status, 'simulated-read-visible');
  w.chain.faults.genesis = 'f'.repeat(64);
  const out = await w.bridge.resume(a);
  assert.deepEqual([out.status, out.code], ['indeterminate', 'invalid-chain']);
  w.chain.faults.genesis = FIXTURE_IDENTITY;
  assert.equal((await w.bridge.resume(a)).status, 'simulated-read-visible');
  assert.equal(w.approvals.filter((r) => r.method === 'sendTransaction').length, 1);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  assert.deepEqual(externalAttempts, []);
});

// the source change (re-review r3, a review P2-1): with the adapter's journal entry lost,
// resume() re-reads the record before any plan exists. Native metadata that
// differs from the signed CREATE, and then the node's own rendering (which
// does not authenticate without the signed bytes), are indeterminate
// readbacks, not a throw the purchase would reject on. Nothing is sent again.
test('a lost adapter journal makes the pre-plan readback indeterminate and sends nothing again', async (t) => {
  const w = await setup(t);
  const a = await realAgreement(w);
  assert.equal((await w.bridge.anchor(a)).status, 'simulated-read-visible');
  const journal = {
    get: (key) => key.startsWith('sr2/adapter/') ? null : w.journal.get(key),
    put: (key, value) => w.journal.put(key, value),
    entries: async () => (await w.journal.entries()).filter(([key]) => !key.startsWith('sr2/adapter/')),
    withWalletLock: (key, work) => w.journal.withWalletLock(key, work),
  };
  const reopened = shipped.createDemosSr2WalletBridge({ rpcUrl: w.chain.url, network: w.network, journal, walletFactory: () => w.bridge.wallet });
  w.chain.faults.native = (native) => ({ ...native, metadata: { ...native.metadata, artifactKind: 'SettlementEvidence' } });
  const junk = await reopened.resume(a);
  assert.deepEqual([junk.status, junk.code], ['indeterminate', 'invalid']);
  w.chain.faults.native = null;
  const clean = await reopened.resume(a);
  assert.deepEqual([clean.status, clean.code], ['indeterminate', 'invalid']);
  assert.equal((await w.bridge.resume(a)).status, 'simulated-read-visible', 'the bridge that kept its plan still reads the record back');
  assert.equal(w.approvals.filter((r) => r.method === 'sendTransaction').length, 1);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  assert.deepEqual(externalAttempts, []);
});
