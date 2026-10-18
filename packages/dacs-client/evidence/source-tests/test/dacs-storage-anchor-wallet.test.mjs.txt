// Source-aware offline compatibility evidence. Real packaged demosdk 4.0.16
// signing through the unchanged real plugin relay to a test-owned SDK-wire
// fixture. Approval callbacks here are test adapters; browser proof is separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contentHash, canonicalize, logicalToStorageProgramName } from '@kynesyslabs/dacs';
import * as shipped from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { describeRequest } from '../public/portal/embedded-wallet/approval.mjs';
import { startHarness } from './helpers/harness.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';
import { startAnchorFixture, anchorRequest, memoryAnchorJournal, digest, FIXTURE_IDENTITY } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';
// Exact installed pin's pure projection helper; the package root does not
// export it and the substrate barrel eagerly loads its optional demosdk peer.
import { demosTransactionContentMatches } from '@kynesyslabs/dacs';

installLoopbackOnlyGuard();
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const { Demos, Identities, validateMnemonic } = await import('../public/portal/embedded-wallet/demos-runtime.mjs');
const clone = (v) => structuredClone(v);
const op = (r) => r.transaction.content.data[1];
const send = (wallet, request) => wallet.session.request({ method: 'sendTransaction', params: [request] });

async function setup(t, { sdk = shipped, journal = memoryAnchorJournal(), decide = () => true, DemosCtor = Demos, fixture = {} } = {}) {
  const chain = await startAnchorFixture(fixture);
  const h = await startHarness({ chain, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
  t.after(() => h.close());
  const network = h.config.chain.network;
  const transport = { profile: 'simulated-loopback', network, rpcUrl: `${h.origin}/portal/api/wallet-rpc` };
  const approvals = [];
  const session = sdk.createSdkWalletSession({ DemosCtor, IdentitiesCtor: Identities, validateMnemonic, anchorJournal: journal, transactionTransport: transport,
    approve: async (r) => { approvals.push(clone(r)); return decide(r, { chain, session }); } });
  const account = await session.create();
  t.after(() => session.lock());
  return { chain, h, network, transport, approvals, session, account, journal, request: (args) => anchorRequest(account.address, network, args) };
}

function failed(result, code) {
  assert.equal(result.success, false, JSON.stringify(result));
  assert.equal(result.error.code, code, result.error.message);
}

test('explicit anchor kind: actual SDK signing, independent owner, exact bytes and complete debit; pre/post fork controls', async (t) => {
  assert.equal(JSON.parse(readFileSync(new URL('../public/portal/embedded-wallet/runtime-manifest.json', import.meta.url))).sdk.version, '4.0.16');
  assert.equal(shipped.DACS_STORAGE_ANCHOR_CHAIN_IDENTITY, FIXTURE_IDENTITY);
  for (const postFork of [true, false]) await t.test(postFork ? 'post-fork OS strings' : 'pre-fork whole DEM', async (s) => {
    const w = await setup(s, { fixture: { postFork } });
    const r = w.request();
    assert.equal(r.contentHash, digest('{"artifactType":"Agreement","jobId":"offline-sr2-job","terms":{"amount":"2.5","currency":"DEM"}}'));
    assert.equal(r.envelopeHash, digest('{"artifactType":"Agreement","jobId":"offline-sr2-job","signatures":[{"opaque":"scope-carrier"}],"terms":{"amount":"2.5","currency":"DEM"}}'));
    assert.equal(contentHash(op(r).data), r.contentHash);
    assert.equal(digest(canonicalize(op(r).data)), r.envelopeHash);
    assert.equal(logicalToStorageProgramName(r.logicalAddress), op(r).programName);
    const out = await send(w, r);
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.evidenceMode, 'simulated-fixture');
    assert.deepEqual(w.chain.record.broadcastAttempts, [out.data.hash]);
    assert.equal(w.approvals.length, 1);
    const a = w.approvals[0].content;
    assert.equal(a.kind, shipped.DACS_STORAGE_ANCHOR_KIND);
    for (const k of ['owner', 'jobId', 'logicalAddress', 'artifactKind', 'contentHash', 'envelopeHash']) assert.equal(a[k], r[k]);
    assert.equal(a.storageAddress, op(r).storageAddress);
    assert.equal(a.programName, op(r).programName);
    assert.equal(a.exactStorageBytes, canonicalize(op(r).data));
    assert.equal(a.exactCreate, JSON.stringify(JSON.parse(canonicalize(op(r)))));
    assert.equal(a.storageBytes, Buffer.byteLength(a.exactStorageBytes));
    assert.deepEqual([a.debit.storageFeeDem, a.debit.sdkGasDem, a.debit.networkFeeDem, a.debit.rpcFeeDem, a.debit.additionalFeeDem, a.debit.totalDem, a.debit.totalOs], ['1', '1', '2', '3', '0', '7', '7000000000']);
    const rendered = describeRequest(w.approvals[0]);
    for (const exact of [r.logicalAddress, r.owner, r.contentHash, r.envelopeHash, a.exactStorageBytes.replaceAll('"', '\\"'), '7000000000']) assert.ok(rendered.content.includes(exact));
    const signed = w.chain.record.accepted[0];
    assert.equal(signed.content.network, w.network);
    assert.equal(signed.content.chainIdentity, FIXTURE_IDENTITY);
    assert.equal(signed.content.gcr_edits.length, 4);
    assert.equal(w.journal.snapshot()[0][1].stage, 'broadcast-accepted');
    assert.equal(w.session.getWriteProfile().transactionKinds.includes(shipped.DACS_STORAGE_ANCHOR_KIND), true);
    failed(await send(w, r), 'stale_plan');
    assert.equal(w.approvals.length, 1, 'consumed nonce cannot ask for another approval');
  });
  assert.deepEqual(externalAttempts, []);
});

test('kind and profile are explicit; generic SR-2 does not relax Listing, default/held profiles never call RPC', async (t) => {
  const w = await setup(t);
  failed(await send(w, w.request().transaction), 'invalid_params');
  assert.deepEqual(w.chain.record.calls, []);
  for (const transport of [undefined, { profile: 'testnet-held', network: 'held-testnet' }, { profile: 'public', network: 'unavailable', rpcUrl: 'http://127.0.0.1:9' }]) {
    const session = shipped.createSdkWalletSession({ DemosCtor: Demos, validateMnemonic, transactionTransport: transport, anchorJournal: memoryAnchorJournal(), approve: async () => true });
    await session.create();
    failed(await session.request({ method: 'sendTransaction', params: [w.request()] }), transport?.profile === 'testnet-held' ? 'held_for_review' : transport ? 'unsupported' : 'not_configured');
    session.lock();
  }
  const noJournal = shipped.createSdkWalletSession({ DemosCtor: Demos, transactionTransport: w.transport });
  await noJournal.create();
  failed(await noJournal.request({ method: 'sendTransaction', params: [w.request()] }), 'not_configured');
  assert.equal(noJournal.getWriteProfile().transactionKinds.includes(shipped.DACS_STORAGE_ANCHOR_KIND), false);
  noJournal.lock();
  for (const rpcUrl of ['https://rpc.example.invalid/portal/api/wallet-rpc', `${w.h.origin}/`, 'http://localhost:9/portal/api/wallet-rpc']) {
    const session = shipped.createSdkWalletSession({ DemosCtor: Demos, transactionTransport: { ...w.transport, rpcUrl }, anchorJournal: memoryAnchorJournal() });
    const account = await session.create();
    failed(await session.request({ method: 'sendTransaction', params: [anchorRequest(account.address, w.network)] }), 'unsupported');
    session.lock();
  }
  assert.deepEqual(w.chain.record.calls, []);
});

test('changed name/hash/envelope/scope/owner/native/nonce/network/CREATE boundaries reject before approval or RPC', async (t) => {
  const w = await setup(t);
  const cases = [
    ['program name', (r) => { op(r).programName = 'dacs1-other'; }],
    ['metadata hash', (r) => { op(r).metadata.contentHash = 'f'.repeat(64); }],
    ['declared scope hash', (r) => { r.contentHash = op(r).metadata.contentHash = 'f'.repeat(64); }],
    ['declared envelope hash', (r) => { r.envelopeHash = op(r).metadata.envelopeHash = 'f'.repeat(64); }],
    ['changed signed scope', (r) => { op(r).data.terms.amount = '3'; }],
    ['changed signature envelope', (r) => { op(r).data.signatures[0].opaque = 'other'; }],
    ['logical address', (r) => { op(r).metadata.logicalAddress = 'dacs3:agreement:other-job'; }],
    ['extra metadata', (r) => { op(r).metadata.extra = 'unapproved'; }],
    ['native address', (r) => { r.transaction.content.to = op(r).storageAddress = `stor-${'f'.repeat(40)}`; }],
    ['nonce-derived coordinate', (r) => { r.transaction.content.nonce = 2; }],
    ['zero nonce', (r) => { r.transaction.content.nonce = 0; }],
    ['unsafe nonce', (r) => { r.transaction.content.nonce = Number.MAX_SAFE_INTEGER + 1; }],
    ['job identity', (r) => { r.jobId = 'different-job'; }],
    ['kind identity', (r) => { r.artifactKind = 'DeliveryEvidence'; }],
    ['network label', (r) => { r.network = 'other'; }],
    ['signed network', (r) => { r.transaction.content.network = 'other'; }],
    ['signed chain', (r) => { r.transaction.content.chainIdentity = 'e'.repeat(64); }],
    ['CREATE operation', (r) => { op(r).operation = 'UPDATE_STORAGE_PROGRAM'; }],
    ['salt', (r) => { op(r).salt = 'changed'; }],
    ['additional fee', (r) => { r.transaction.content.transaction_fee.additional_fee = 1; }],
    ['hidden content charge', (r) => { r.transaction.content.custom_charges = [{ amount: 1 }]; }],
    ['owner claim', (r) => { r.owner = `did:demos:agent:${'f'.repeat(64)}`; }, 'wrong_wallet'],
    ['sender', (r) => { r.transaction.content.from = `0x${'f'.repeat(64)}`; }, 'wrong_wallet'],
  ];
  for (const [name, change, code = 'invalid_params'] of cases) await t.test(name, async () => {
    const request = w.request(); change(request);
    failed(await send(w, request), code);
    assert.equal(w.approvals.length, 0);
    assert.equal(w.chain.record.calls.length, 0);
  });
  assert.equal((await send(w, w.request())).success, true, 'otherwise-valid accepting control');
});

test('exact storage fee chunk boundary and 24 KiB relay-safe/name bounds', async (t) => {
  for (const bytes of [10240, 10241, 24576]) await t.test(`${bytes} artifact bytes`, async (s) => {
    const w = await setup(s);
    const artifact = { artifactType: 'Agreement', body: '', jobId: 'offline-sr2-job' };
    artifact.body = 'a'.repeat(bytes - Buffer.byteLength(canonicalize(artifact)));
    const out = await send(w, w.request({ artifact }));
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(w.approvals[0].content.storageBytes, bytes);
    assert.equal(w.approvals[0].content.debit.storageFeeDem, String(Math.ceil(bytes / 10240)));
  });
  const w = await setup(t);
  const overflow = { artifactType: 'Agreement', body: '', jobId: 'offline-sr2-job' };
  overflow.body = 'a'.repeat(24577 - Buffer.byteLength(canonicalize(overflow)));
  failed(await send(w, w.request({ artifact: overflow })), 'invalid_params');
  failed(await send(w, w.request({ logicalAddress: `dacs3:${'a'.repeat(250)}` })), 'invalid_params');
  assert.equal(w.approvals.length, 0);
});

test('browser CF-1 snapshot agrees with the pinned SDK; non-JSON or mutable members are refused', async (t) => {
  const w = await setup(t);
  const cases = [
    ['nonfinite', (r) => { op(r).data.extra = Infinity; }],
    ['undefined', (r) => { op(r).data.extra = undefined; }],
    ['bigint', (r) => { op(r).data.extra = 1n; }],
    ['lone surrogate', (r) => { op(r).data.extra = '\uD800'; }],
    ['accessor', (r) => { Object.defineProperty(op(r).data, 'extra', { enumerable: true, get() { throw new Error('must not evaluate getter'); } }); }],
    ['hidden member', (r) => { Object.defineProperty(op(r).data, 'extra', { value: 'hidden', enumerable: false }); }],
    ['symbol', (r) => { op(r).data[Symbol('extra')] = 'hidden'; }],
    ['sparse array', (r) => { op(r).data.extra = Array(2); }],
    ['array extra', (r) => { op(r).data.extra = [1]; op(r).data.extra.hidden = true; }],
    ['nonplain object', (r) => { op(r).data.extra = new Date(); }],
    ['cycle', (r) => { op(r).data.extra = op(r).data; }],
    ['excessive nesting', (r) => { let current = op(r).data; for (let i = 0; i < 70; i++) { current.extra = {}; current = current.extra; } }],
  ];
  for (const [name, change] of cases) await t.test(name, async () => {
    const r = w.request(); change(r); failed(await send(w, r), 'invalid_params');
    assert.equal(w.approvals.length, 0); assert.equal(w.chain.record.calls.length, 0);
  });
  const artifact = { '10': 'ten', '2': 'two', artifactType: 'Agreement', jobId: 'offline-sr2-job', text: 'ASCII exact bytes', signatures: [{ raw: 'unsigned carrier' }], nested: { signatures: 'retained signed data' } };
  const r = w.request({ artifact });
  assert.equal(r.contentHash, contentHash(artifact));
  assert.equal(r.envelopeHash, digest(canonicalize(artifact)));
  const out = await send(w, r);
  assert.equal(out.success, true, JSON.stringify(out));
  const a = w.approvals[0].content;
  assert.equal(a.exactStorageBytes, JSON.stringify(w.chain.record.accepted[0].content.data[1].data), 'the approval shows the actual JSON storage bytes, including numeric-key ordering');
  assert.equal(JSON.parse(a.exactStorageBytes).text, 'ASCII exact bytes');
  assert.equal(a.storageBytes, Buffer.byteLength(a.exactStorageBytes));
  // Exact upstream limitation, not permission to weaken the UTF-8 hash check:
  // 4.0.16's signed hash differs from SHA256(UTF8(JSON.stringify(content)))
  // when non-ASCII strings are present. The scoped wallet rejects it locally.
  await t.test('non-ASCII packaged SDK hash mismatch is held before confirm/send', async (s) => {
    let captured;
    class Capture extends Demos { async sign(...args) { captured = await super.sign(...args); return captured; } }
    const x = await setup(s, { DemosCtor: Capture });
    const value = { artifactType: 'Agreement', jobId: 'offline-sr2-job', text: 'Cafe\u0301 \u{1f680}' };
    const request = x.request({ artifact: value });
    assert.equal(request.contentHash, contentHash(value));
    assert.equal(request.envelopeHash, digest(canonicalize(value)));
    failed(await send(x, request), 'payload_mismatch');
    const expectedUtf8Hash = digest(JSON.stringify(captured.content));
    assert.notEqual(captured.hash, expectedUtf8Hash, 'independent UTF-8 digest exposes the upstream mismatch');
    s.diagnostic(`packaged SDK hash ${captured.hash}; independent SHA256 UTF-8 content hash ${expectedUtf8Hash}; payload_mismatch before confirm/broadcast`);
    assert.equal(captured.content.data[1].data.text, 'Caf\u00e9 \u{1f680}');
    assert.equal(x.chain.record.confirms.length, 0);
    assert.equal(x.chain.record.broadcastAttempts.length, 0);
  });
});

test('approval must explicitly accept; locking, changed nonce/network/fees and input mutation are controlled', async (t) => {
  for (const [name, decide, code] of [
    ['decline', () => false, 'user_rejected'],
    ['lock', (_r, { session }) => { session.lock(); return true; }, 'locked'],
    ['nonce drift', (_r, { chain, session }) => { chain.setNonce(session.getPublicAccount().address, 1); return true; }, 'stale_plan'],
    ['network drift', (_r, { chain }) => { chain.faults.chainIdentity = 'e'.repeat(64); return true; }, 'payload_mismatch'],
    ['denomination drift', (_r, { chain }) => { chain.faults.postFork = false; return true; }, 'payload_mismatch'],
    ['fee drift', (_r, { chain }) => { chain.faults.networkFee = 12; return true; }, 'payload_mismatch'],
  ]) await t.test(name, async (s) => {
    const w = await setup(s, { decide }); failed(await send(w, w.request()), code);
    assert.equal(w.chain.record.broadcastAttempts.length, 0);
    assert.equal(w.chain.record.confirms.length, 0);
  });
  let original;
  const w = await setup(t, { decide: () => { op(original).data.terms.amount = '99'; original.transaction.content.network = 'other'; return true; } });
  original = w.request();
  assert.equal((await send(w, original)).success, true);
  assert.equal(w.chain.record.accepted[0].content.data[1].data.terms.amount, '2.5', 'signs the captured exact bytes');
});

test('actual signer alterations cannot issue a payload with hidden debit, storage edit, signature, fees or network changes', async (t) => {
  const cases = [
    ['extra debit', (s) => s.content.gcr_edits.push(clone(s.content.gcr_edits[0]))],
    ['rollback', (s) => { s.content.gcr_edits[0].isRollback = true; }],
    ['storage edit', (s) => { s.content.gcr_edits[1].context.data.variables.metadata.contentHash = 'f'.repeat(64); }],
    ['hidden fee', (s) => { s.content.transaction_fee.additional_fee = '1000000000'; }],
    ['network', (s) => { s.content.network = 'other'; }],
    ['nonce', (s) => { s.content.nonce = 2; }],
    ['bad signature', (s) => { s.signature.data = `0x${'0'.repeat(128)}`; }, false],
  ];
  for (const [name, change, resign = true] of cases) await t.test(name, async (s) => {
    class Altered extends Demos {
      async sign(...args) {
        const signed = await super.sign(...args); change(signed);
        if (resign) { signed.hash = digest(JSON.stringify(signed.content)); signed.signature = await this.signMessage(signed.hash, { algorithm: 'ed25519' }); }
        return signed;
      }
    }
    const w = await setup(s, { DemosCtor: Altered });
    failed(await send(w, w.request()), 'payload_mismatch');
    assert.equal(w.approvals.length, 1);
    assert.equal(w.chain.record.confirms.length, 0);
    assert.equal(w.chain.record.broadcastAttempts.length, 0);
  });
});

test('confirmation retains every approved field, projection and debit; changed responses never broadcast', async (t) => {
  const cases = [
    ['envelope', (d) => { d.transaction.content.data[1].data.signatures[0].opaque = 'different'; }],
    ['scope', (d) => { d.transaction.content.data[1].metadata.contentHash = 'f'.repeat(64); }],
    ['owner', (d) => { d.transaction.content.from = `0x${'f'.repeat(64)}`; }],
    ['nonce', (d) => { d.transaction.content.nonce = 2; }],
    ['network', (d) => { d.transaction.content.network = 'other'; }],
    ['chain', (d) => { d.transaction.content.chainIdentity = 'f'.repeat(64); }],
    ['native', (d) => { d.transaction.content.to = `stor-${'f'.repeat(40)}`; }],
    ['program name', (d) => { d.transaction.content.data[1].programName = 'different'; }],
    ['hash', (d) => { d.transaction.hash = 'f'.repeat(64); }],
    ['signature', (d) => { d.transaction.signature.data = `0x${'0'.repeat(128)}`; }],
    ['fee', (d) => { d.transaction.content.transaction_fee.network_fee = '99000000000'; }],
    ['fee extra', (d) => { d.transaction.content.transaction_fee.extra = 'hidden'; }],
    ['RPC fee recipient', (d) => { d.transaction.content.transaction_fee.rpc_address = `0x${'f'.repeat(64)}`; }],
    ['hidden transaction field', (d) => { d.transaction.extra_charges = [{ amount: 1 }]; }],
    ['hidden confirmation field', (d) => { d.extra_charges = [{ amount: 1 }]; }],
    ['custom charge', (d) => { d.custom_charges = [{ amount: '1000000000' }]; }],
    ['gas view', (d) => { d.gas_operation = { fees: { network_fee: '2000000000', rpc_fee: '3000000000', additional_fee: '1000000000' } }; }],
    ['extra edit', (d) => { d.transaction.content.gcr_edits.push(clone(d.transaction.content.gcr_edits[0])); }],
    ['edit amount', (d) => { d.transaction.content.gcr_edits[0].amount = '99000000000'; }],
    ['edit target', (d) => { d.transaction.content.gcr_edits[1].target = `stor-${'f'.repeat(40)}`; }],
    ['edit txhash', (d) => { d.transaction.content.gcr_edits[3].txhash = 'f'.repeat(64); }],
    ['edit rollback', (d) => { d.transaction.content.gcr_edits[1].isRollback = true; }],
    ['edit hidden property', (d) => { d.transaction.content.gcr_edits[2].hidden = 'charge'; }],
  ];
  for (const [name, change] of cases) await t.test(name, async (s) => {
    const w = await setup(s);
    w.chain.faults.confirmation = (response) => change(response.data);
    failed(await send(w, w.request()), 'confirm_rejected');
    assert.equal(w.approvals.length, 1);
    assert.equal(w.chain.record.confirms.length, 1);
    assert.equal(w.chain.record.broadcastAttempts.length, 0);
    w.chain.faults.confirmation = null;
    assert.equal((await send(w, w.request())).success, true, 'otherwise-valid accepting control');
  });
});

test('documented signed-to-executed integer/txhash projection retains the pinned SDK proof contract', async (t) => {
  const w = await setup(t);
  w.chain.faults.confirmation = (response) => {
    const tx = response.data.transaction;
    tx.content.amount = 0;
    tx.content.nonce = String(tx.content.nonce);
    tx.content.timestamp = String(tx.content.timestamp);
    for (const k of ['network_fee', 'rpc_fee', 'additional_fee']) tx.content.transaction_fee[k] = Number(tx.content.transaction_fee[k]);
    for (const edit of tx.content.gcr_edits) {
      if (Object.hasOwn(edit, 'amount')) edit.amount = String(edit.amount);
      edit.txhash = tx.hash;
    }
    response.data.gas_operation = { fees: { network_fee: 2000000000, rpc_fee: 3000000000, additional_fee: 0 } };
  };
  const out = await send(w, w.request());
  assert.equal(out.success, true, JSON.stringify(out));
  const signed = w.chain.record.confirms[0];
  const projected = w.chain.record.accepted[0];
  assert.equal(demosTransactionContentMatches(signed.content, projected.content, signed.hash), true);
  assert.equal(w.chain.record.broadcastAttempts.length, 1);
});

test('unmarked/incorrect fixture identity and unsupported fee boundaries are never approved', async (t) => {
  for (const [key, value, code] of [['marker', false, 'upstream_unavailable'], ['simulated', false, 'upstream_unavailable'], ['chainIdentity', 'e'.repeat(64), 'upstream_unavailable'],
    ['networkFee', 0.5, 'unsupported'], ['rpcFee', -1, 'unsupported'], ['networkFee', Number.MAX_SAFE_INTEGER + 1, 'unsupported']]) await t.test(`${key} ${value}`, async (s) => {
    const w = await setup(s); w.chain.faults[key] = value;
    failed(await send(w, w.request()), code);
    assert.equal(w.approvals.length, 0);
    assert.equal(w.chain.record.broadcastAttempts.length, 0);
  });
});

test('unknown broadcast is sent once through retry-safe relay; shared/restored journal fences all later payloads', async (t) => {
  const w = await setup(t);
  w.chain.faults.dropAfterApply = true;
  const r = w.request();
  const out = await send(w, r);
  failed(out, 'outcome_unknown');
  assert.equal(w.chain.record.accepted.length, 1);
  assert.deepEqual(w.chain.record.broadcastAttempts, [out.data.hash], '503 upstream is converted to 500; actual SDK never retries');
  const saved = JSON.parse(JSON.stringify(w.journal.snapshot()));
  assert.equal(saved[0][1].stage, 'broadcast-started');
  failed(await send(w, r), 'outcome_unknown');
  failed(await send(w, w.request({ nonce: 2, logicalAddress: 'dacs3:agreement:another' })), 'outcome_unknown');
  const native = { content: { type: 'native' } };
  failed(await send(w, native), 'outcome_unknown');
  const mnemonic = w.session.exportMnemonicForUser();
  w.session.lock();
  const restored = shipped.createSdkWalletSession({ DemosCtor: Demos, validateMnemonic, transactionTransport: w.transport, anchorJournal: memoryAnchorJournal(saved), approve: async () => { throw new Error('must not prompt'); } });
  await restored.importMnemonic(mnemonic);
  failed(await restored.request({ method: 'sendTransaction', params: [r] }), 'outcome_unknown');
  restored.lock();
  assert.equal(w.approvals.length, 1);
  assert.equal(w.chain.record.broadcastAttempts.length, 1);
});

test('shared atomic lane serializes separate sessions; persistence failures never broadcast', async (t) => {
  const w = await setup(t);
  const second = shipped.createSdkWalletSession({ DemosCtor: Demos, validateMnemonic, transactionTransport: w.transport, anchorJournal: w.journal, approve: async () => true });
  await second.importMnemonic(w.session.exportMnemonicForUser());
  const request = w.request();
  const outcomes = await Promise.all([send(w, request), second.request({ method: 'sendTransaction', params: [request] })]);
  assert.equal(outcomes.filter((v) => v.success).length, 1);
  failed(outcomes.find((v) => !v.success), 'stale_plan');
  assert.equal(w.chain.record.broadcastAttempts.length, 1);
  second.lock();
  for (const journal of [{ ...memoryAnchorJournal(), put: async () => { throw new Error('disk failure'); } }, { ...memoryAnchorJournal(), put: async () => {} }]) await t.test('journal failed or did not retain', async (s) => {
    const x = await setup(s, { journal });
    assert.equal((await send(x, x.request())).success, false);
    assert.equal(x.chain.record.broadcastAttempts.length, 0);
  });
});

test('repeatable guard witnesses retain controls and catch envelope-hash and node-charge guard removal', async (t) => {
  const source = readFileSync(new URL('../public/portal/embedded-wallet/sdk-provider.mjs', import.meta.url), 'utf8');
  const cases = [
    { before: 'await sha256HexOfText(envelope) !== r.envelopeHash', after: 'false',
      change: (w, r) => { r.envelopeHash = op(r).metadata.envelopeHash = 'f'.repeat(64); }, code: 'invalid_params' },
    { before: '&& data.custom_charges == null\n', after: '&& true\n',
      change: (w) => { w.chain.faults.confirmation = (response) => { response.data.custom_charges = [{ amount: '1000000000' }]; }; }, code: 'confirm_rejected' },
  ];
  for (const witness of cases) await t.test(witness.code, async (s) => {
    assert.ok(source.includes(witness.before));
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(source.replace(witness.before, witness.after)).toString('base64')}`);
    for (const sdk of [shipped, mutant]) {
      const control = await setup(s, { sdk });
      assert.equal((await send(control, control.request())).success, true, 'accepting control retained');
      const negative = await setup(s, { sdk });
      const r = negative.request(); witness.change(negative, r);
      const out = await send(negative, r);
      if (sdk === shipped) { failed(out, witness.code); assert.equal(negative.chain.record.broadcastAttempts.length, 0); }
      else { assert.equal(out.success, true, 'wrong implementation accepts the independently prepared negative'); assert.equal(negative.chain.record.broadcastAttempts.length, 1); }
    }
  });
});
