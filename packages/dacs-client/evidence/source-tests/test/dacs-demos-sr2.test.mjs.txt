// Source-aware OFFLINE adapter contract tests, not independent validation.
// Real packaged embedded-wallet signing; test-owned SDK-wire storage CREATE
// confirm/broadcast on literal loopback. No real RPC, funds or chain writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalize, contentHash, storAddress, decodeDemosAnchorReceiptProof, assertDemosWriteEvidence } from '@kynesyslabs/dacs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { createSdkWalletSession } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import * as shipped from '../src/dacs/demos-sr2-adapter.mjs';
import { createSellerSr2AgreementAnchor } from '../src/dacs/seller-sr2-agreement-consumer.mjs';
import { createNativePaymentEvidenceConsumer } from '../src/dacs/native-payment-evidence-consumer.mjs';

// Minimal browser-global fixture, matching the existing embedded-wallet SDK
// tests. This loads the real shipped bundle in Node; it is not browser proof.
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const { Demos, Identities, validateMnemonic } = await import('../public/portal/embedded-wallet/demos-runtime.mjs');

const digest = (s) => createHash('sha256').update(s).digest('hex');
const fixtureIdentity = digest('dacs-chatgpt-plugin/demos-sr2-sdk-wire-fixture/v1');
const spki = Buffer.from('302a300506032b6570032100', 'hex');
const addr = /^0x[0-9a-f]{64}$/;
const hash = /^[0-9a-f]{64}$/;
const native = /^stor-[0-9a-f]{40}$/;
const clone = (v) => structuredClone(v);
const artifact = () => ({ artifactType: 'Agreement', jobId: 'offline-sr2-job', terms: { amount: '2.5', currency: 'DEM' }, signatures: [{ opaque: 'signed-scope-carrier' }] });
const logical = 'dacs3:agreement:offline-sr2-job';
const claim = (wallet) => `did:demos:agent:${wallet.address.slice(2)}`;
const addressFrom = (owner, name, nonce) => `stor-${digest(`${owner}:${name}:${nonce}:`).slice(0, 40)}`;

function validSignature(owner, message, signature) {
  try {
    const key = createPublicKey({ key: Buffer.concat([spki, Buffer.from(owner.slice(2), 'hex')]), type: 'spki', format: 'der' });
    return verify(null, Buffer.from(message), key, Buffer.from(signature.replace(/^0x/, ''), 'hex'));
  } catch { return false; }
}

// Independently written node fixture. It does not call the adapter, any DACS
// address helper, evidence helper, wallet payload builder or signature verifier.
// The request/response envelope is the existing demosdk 4.0.16 wire profile.
async function startWireFixture(t) {
  const nonces = new Map();
  const programs = new Map();
  const transactions = new Map();
  const blocks = new Map();
  const calls = [];
  const faults = { unavailable: false, marker: true, chainIdentity: fixtureIdentity, indexLag: false, repeatPage: false,
    search: null, native: null, tx: null, block: null, dropAfterApply: false };
  let accepted = 0;
  const genesis = () => ({ number: 0, status: 'confirmed', hash: faults.chainIdentity, content: { timestamp: 1791144000, ordered_transactions: [] } });
  function check(tx) {
    const c = tx?.content;
    const op = c?.data?.[1];
    if (!c || !addr.test(c.from) || c.from_ed25519_address !== c.from || !hash.test(tx.hash)
      || digest(JSON.stringify(c)) !== tx.hash || tx.signature?.type !== 'ed25519' || !validSignature(c.from, tx.hash, tx.signature.data)) return 'writer/hash/signature';
    if (c.nonce !== (nonces.get(c.from) ?? 0) + 1) return 'nonce';
    if (c.type !== 'storageProgram' || c.data?.[0] !== 'storageProgram' || op?.operation !== 'CREATE_STORAGE_PROGRAM'
      || op.encoding !== 'json' || !op.data || !op.metadata || !native.test(op.storageAddress) || c.to !== op.storageAddress
      || addressFrom(c.from, op.programName, c.nonce) !== c.to || programs.has(c.to)) return 'create';
    return null;
  }
  function apply(tx) {
    const c = clone(tx.content);
    const op = c.data[1];
    nonces.set(c.from, c.nonce);
    const number = blocks.size + 1;
    const content = { timestamp: 1791144000 + number * 5, ordered_transactions: [tx.hash] };
    const validation_data = { simulated: true, chainIdentity: faults.chainIdentity, fixtureValidator: 'no-real-consensus' };
    const block = { number, status: 'confirmed', hash: digest(JSON.stringify({ number, content, validation_data })), content, validation_data };
    blocks.set(number, block);
    transactions.set(tx.hash, { hash: tx.hash, content: c, signature: clone(tx.signature), status: 'confirmed', blockNumber: number });
    programs.set(c.to, { success: true, storageAddress: c.to, data: clone(op.data), metadata: clone(op.metadata), owner: c.from,
      programName: op.programName, createdByTx: tx.hash, interactionTxs: [tx.hash] });
    accepted += 1;
  }
  function nodeCall(message, data) {
    if (message === 'getAddressNonce') return nonces.get(data.address) ?? 0;
    if (message === 'getBlockByNumber') return data.blockNumber === 0 ? genesis() : faults.block?.(clone(blocks.get(data.blockNumber))) ?? clone(blocks.get(data.blockNumber) ?? null);
    if (message === 'getTxByHash') return faults.tx?.(clone(transactions.get(data.hash))) ?? clone(transactions.get(data.hash) ?? null);
    if (message === 'searchStoragePrograms') {
      const entries = [...programs.values()].filter((p) => p.programName === data.query).map((p) => ({ storageAddress: p.storageAddress, programName: p.programName }));
      const rows = faults.indexLag ? [] : entries.slice(data.options.offset, data.options.offset + data.options.limit);
      if (faults.repeatPage) return Array.from({ length: 50 }, () => entries[0]);
      return faults.search?.(clone(rows)) ?? rows;
    }
    return undefined;
  }
  const server = http.createServer(async (req, res) => {
    function send(code, body) {
      res.writeHead(code, { 'content-type': 'application/json', ...(faults.marker ? { 'x-dacs-simulation': 'fixture' } : {}) });
      res.end(JSON.stringify(body));
    }
    if (faults.unavailable) return send(503, { error: 'fixture unavailable' });
    if (req.method === 'GET') {
      calls.push(`GET ${req.url}`);
      const program = programs.get(req.url.slice('/storage-program/'.length));
      return program ? send(200, faults.native?.(clone(program)) ?? clone(program)) : send(404, { success: false, error: 'not found' });
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const call = request.params?.[0];
    calls.push(`${request.method}:${call?.message ?? call?.extra}`);
    if (request.method === 'execute') {
      if (call.extra === 'confirmTx') {
        const problem = check(call.data);
        return send(200, { result: 200, response: { data: { valid: problem === null, transaction: call.data, message: problem }, signature: { type: 'ed25519', data: '' } } });
      }
      if (call.extra === 'broadcastTx') {
        const tx = call.data?.response?.data?.transaction;
        const problem = check(tx);
        if (problem) return send(200, { result: 400, response: problem });
        apply(tx);
        if (faults.dropAfterApply) return req.socket.destroy();
        return send(200, { result: 200, response: { txHash: tx.hash } });
      }
    }
    if (request.method !== 'nodeCall') return send(400, { result: 400 });
    const response = nodeCall(call.message, call.data);
    return send(200, { result: response === undefined ? 400 : 200, response: response ?? null });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  async function execute(phase, data) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'execute', params: [{ extra: phase, data }] }) });
    return response.json();
  }
  return { url, faults, calls, programs, transactions, blocks, nonces, accepted: () => accepted,
    async submit(tx) {
      const validity = await execute('confirmTx', tx);
      assert.equal(validity.response.data.valid, true, 'test-owned submitter requires independent fixture validation');
      return execute('broadcastTx', validity);
    },
    async duplicate(tx) { return execute('broadcastTx', { response: { data: { transaction: tx } } }); },
  };
}

function world(chain, module = shipped, journal = module.createInMemoryDemosSr2Journal()) {
  return { journal, adapter: module.createDemosSr2Adapter({ rpcUrl: chain.url, journal, now: () => 1791144400000 }) };
}
async function anchored(chain, wallet = createEphemeralWallet(), module = shipped, name = logical, value = artifact(), journal) {
  const w = world(chain, module, journal);
  const writer = claim(wallet);
  const plan = await w.adapter.planWrite({ logicalAddress: name, artifact: value, writer });
  const handoff = await w.adapter.takeWalletHandoff({ planId: plan.planId, walletAddress: wallet.address });
  const signature = wallet.signHex(handoff.request.params[0]);
  const authorized = await w.adapter.authorizeWrite({ planId: plan.planId, walletAddress: wallet.address, writerSignature: signature });
  await chain.submit(authorized.signedTransaction);
  const txHash = authorized.signedTransaction.hash;
  const receipt = await w.adapter.write({ logicalAddress: name, artifact: value, writer, transactionHash: txHash });
  return { ...w, writer, wallet, value, name, plan, handoff, authorized, txHash, receipt };
}
async function failure(promise, code) { await assert.rejects(promise, (error) => error.code === code); }

test('accepting control: packaged embedded wallet exactly authorizes buyer CREATE; a separate seller key writes its own record', async (t) => {
  const chain = await startWireFixture(t);
  const approvals = [];
  const wallet = createSdkWalletSession({ DemosCtor: Demos, IdentitiesCtor: Identities, validateMnemonic, approve: async (r) => { approvals.push(clone(r)); return true; } });
  t.after(() => wallet.lock());
  const account = await wallet.create();
  const w = world(chain);
  const value = artifact();
  const writer = `did:demos:agent:${account.address.slice(2)}`;
  const plan = await w.adapter.planWrite({ logicalAddress: logical, artifact: value, writer });
  assert.equal(plan.nativeAddress, addressFrom(account.address, 'dacs3%3Aagreement%3Aoffline-sr2-job', 1));
  assert.notEqual(plan.nativeAddress, storAddress(logical), 'the logical storAddress is not the native nonce-derived address');
  const handoff = await w.adapter.takeWalletHandoff({ planId: plan.planId, walletAddress: account.address });
  assert.deepEqual(handoff.request, { method: 'sign', params: [digest(JSON.stringify(handoff.unsignedTransaction.content))] });
  const signed = await wallet.request(handoff.request);
  assert.equal(signed.success, true);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].address, account.address);
  assert.equal(approvals[0].message, handoff.request.params[0]);
  const authorized = await w.adapter.authorizeWrite({ planId: plan.planId, walletAddress: account.address, writerSignature: signed.data.signature });
  await chain.submit(authorized.signedTransaction);
  const receipt = await w.adapter.write({ logicalAddress: logical, artifact: value, writer, transactionHash: authorized.signedTransaction.hash });
  const read = await w.adapter.read(logical, { expectedWriter: writer });
  assert.equal(read.evidenceMode, 'simulated-fixture');
  assert.deepEqual(read.artifact, value);
  assert.equal(receipt.writer, writer);
  const expectedScope = digest('{"artifactType":"Agreement","jobId":"offline-sr2-job","terms":{"amount":"2.5","currency":"DEM"}}');
  const expectedEnvelope = digest('{"artifactType":"Agreement","jobId":"offline-sr2-job","signatures":[{"opaque":"signed-scope-carrier"}],"terms":{"amount":"2.5","currency":"DEM"}}');
  assert.equal(receipt.contentHash, expectedScope, 'scope expectation is derived from independently written JCS bytes');
  assert.equal(read.demosEvidence.nativeRead.valueHash, expectedEnvelope);
  assert.equal(plan.envelopeHash, expectedEnvelope);
  assert.notEqual(receipt.contentHash, expectedEnvelope, 'signed scope and envelope hashes are distinct and both bound');
  assert.equal(receipt.blockRef.height, '1');
  assert.equal(receipt.blockRef.timestamp, 1791144005000);
  assert.equal(decodeDemosAnchorReceiptProof(receipt).chainIdentity, fixtureIdentity);
  assert.doesNotThrow(() => assertDemosWriteEvidence(read.demosEvidence));
  assert.equal(await w.adapter.verifyReceipt({ receipt, logicalAddress: logical, artifact: value, expectedWriter: writer }), 'valid');
  const seller = await anchored(chain, createEphemeralWallet(), shipped, 'dacs3:commitment:offline-sr2-job');
  assert.notEqual(seller.writer, writer);
  assert.equal(seller.receipt.writer, seller.writer);
  assert.equal(chain.nonces.get(account.address), 1);
  assert.equal(chain.nonces.get(seller.wallet.address), 1);
  assert.equal(chain.accepted(), 2);
});

test('current embedded sendTransaction incompatibility is explicit and testnet writes remain held', async (t) => {
  const chain = await startWireFixture(t);
  for (const profile of ['simulated-loopback', 'testnet-held']) {
    const wallet = createSdkWalletSession({ DemosCtor: Demos, IdentitiesCtor: Identities, validateMnemonic, approve: async () => true,
      transactionTransport: { profile, network: 'testnet', ...(profile === 'simulated-loopback' ? { rpcUrl: chain.url } : {}) } });
    t.after(() => wallet.lock());
    const account = await wallet.create();
    const w = world(chain);
    const p = await w.adapter.planWrite({ logicalAddress: logical, artifact: artifact(), writer: `did:demos:agent:${account.address.slice(2)}` });
    const h = await w.adapter.takeWalletHandoff({ planId: p.planId, walletAddress: account.address });
    const before = chain.calls.length;
    const result = await wallet.request({ method: 'sendTransaction', params: [h.unsignedTransaction] });
    assert.equal(result.success, false);
    assert.equal(result.error.code, profile === 'testnet-held' ? 'held_for_review' : 'invalid_params');
    assert.equal(chain.calls.length, before, 'incompatible/held payload reaches no RPC');
  }
  assert.equal(chain.accepted(), 0);
});

test('wrong wallet, wrong message and unsigned readback cannot authorize a buyer anchor', async (t) => {
  const chain = await startWireFixture(t);
  const buyer = createEphemeralWallet();
  const seller = createEphemeralWallet();
  const w = world(chain);
  const value = artifact();
  const p = await w.adapter.planWrite({ logicalAddress: logical, artifact: value, writer: buyer.claim });
  await failure(w.adapter.takeWalletHandoff({ planId: p.planId, walletAddress: seller.address }), 'wrong-writer');
  const h = await w.adapter.takeWalletHandoff({ planId: p.planId, walletAddress: buyer.address });
  await failure(w.adapter.authorizeWrite({ planId: p.planId, walletAddress: buyer.address, writerSignature: seller.signHex(h.request.params[0]) }), 'wrong-writer');
  await failure(w.adapter.authorizeWrite({ planId: p.planId, walletAddress: buyer.address, writerSignature: buyer.signHex('stale or changed content') }), 'wrong-writer');
  await failure(w.adapter.write({ logicalAddress: logical, artifact: value, writer: buyer.claim, transactionHash: '0'.repeat(64) }), 'authorization-required');
  const authorized = await w.adapter.authorizeWrite({ planId: p.planId, walletAddress: buyer.address, writerSignature: buyer.signHex(h.request.params[0]) });
  await chain.submit(authorized.signedTransaction);
  chain.faults.tx = (tx) => ({ ...tx, signature: { type: 'ed25519', data: `0x${'0'.repeat(128)}` } });
  await failure(w.adapter.write({ logicalAddress: logical, artifact: value, writer: buyer.claim, transactionHash: authorized.signedTransaction.hash }), 'invalid');
  assert.equal(chain.accepted(), 1);
});

test('changed envelope, signed scope, nonce or receipt hash fails with exact boundaries', async (t) => {
  const chain = await startWireFixture(t);
  const a = await anchored(chain);
  const changedScope = clone(a.value); changedScope.terms.amount = '3';
  const changedSignature = clone(a.value); changedSignature.signatures[0].opaque = 'different-envelope-same-scope';
  assert.equal(contentHash(changedSignature), contentHash(a.value));
  for (const changed of [changedScope, changedSignature]) await failure(a.adapter.planWrite({ logicalAddress: logical, artifact: changed, writer: a.writer }), 'conflict');
  assert.equal(await a.adapter.verifyReceipt({ receipt: a.receipt, logicalAddress: logical, artifact: changedSignature, expectedWriter: a.writer }), 'invalid');
  const stale = world(chain);
  const wallet = createEphemeralWallet();
  const p = await stale.adapter.planWrite({ logicalAddress: 'dacs4:stale', artifact: artifact(), writer: wallet.claim });
  chain.nonces.set(wallet.address, 1);
  await failure(stale.adapter.takeWalletHandoff({ planId: p.planId, walletAddress: wallet.address }), 'stale-plan');
  assert.equal(chain.accepted(), 1);
  for (const bad of [0, -1, Number.MAX_SAFE_INTEGER]) {
    const fresh = world(chain);
    const other = createEphemeralWallet();
    if (bad !== 0) chain.nonces.set(other.address, bad);
    if (bad === 0) {
      await failure(fresh.adapter.planWrite({ logicalAddress: 'dacs4:x', artifact: artifact(), writer: other.claim, receiptContentHash: 'bad' }), 'invalid');
    } else await failure(fresh.adapter.planWrite({ logicalAddress: 'dacs4:x', artifact: artifact(), writer: other.claim }), 'indeterminate');
  }
});

test('receipt binds writer, scope, native slot, transaction, block, chain and proof hashes', async (t) => {
  const chain = await startWireFixture(t);
  const a = await anchored(chain);
  const alterations = [
    (r) => { r.writer = createEphemeralWallet().claim; },
    (r) => { r.logicalAddress = 'dacs3:agreement:another-job'; },
    (r) => { r.nativeAddress = `stor-${'f'.repeat(40)}`; },
    (r) => { r.contentHash = 'f'.repeat(64); },
    (r) => { r.nonce = '2'; },
    (r) => { r.transactionRef.value = 'f'.repeat(64); },
    (r) => { r.blockRef.id = 'f'.repeat(64); },
    (r) => { r.blockRef.height = '2'; },
    (r) => { r.blockRef.timestamp += 1; },
    (r) => { r.state = 'accepted'; },
    (r) => { r.evidence.value += '='; },
    (r) => { const p = JSON.parse(Buffer.from(r.evidence.value, 'base64url')); p.chainIdentity = 'f'.repeat(64); r.evidence.value = Buffer.from(canonicalize(p)).toString('base64url'); },
    (r) => { const p = JSON.parse(Buffer.from(r.evidence.value, 'base64url')); p.signedTransactionHash = 'f'.repeat(64); r.evidence.value = Buffer.from(canonicalize(p)).toString('base64url'); },
    (r) => { const p = JSON.parse(Buffer.from(r.evidence.value, 'base64url')); p.finalityProofHash = 'f'.repeat(64); r.evidence.value = Buffer.from(canonicalize(p)).toString('base64url'); },
  ];
  // Alterations checked against the request with no read are invalid. The
  // others differ only from fresh node facts (transaction pointer, block, proof
  // hashes), which are not a writer-signed contradiction: indeterminate (the source change).
  const againstRequest = new Set([0, 1, 2, 3, 4, 11]);
  for (let i = 0; i < alterations.length; i += 1) {
    const receipt = clone(a.receipt); alterations[i](receipt);
    const answer = await a.adapter.verifyReceipt({ receipt, logicalAddress: logical, artifact: a.value, expectedWriter: a.writer });
    assert.equal(answer, againstRequest.has(i) ? 'invalid' : 'indeterminate', `alteration ${i} must never verify`);
  }
  assert.equal(await a.adapter.verifyReceipt({ receipt: a.receipt, logicalAddress: logical, artifact: a.value, expectedWriter: a.writer }), 'valid');
});

test('changed native facts and wrong inclusion are invalid; unavailable observations are indeterminate', async (t) => {
  const chain = await startWireFixture(t);
  const a = await anchored(chain);
  const mutations = [
    (n) => ({ ...n, owner: createEphemeralWallet().address }),
    (n) => ({ ...n, storageAddress: `stor-${'f'.repeat(40)}` }),
    (n) => ({ ...n, programName: 'dacs3%3Aagreement%3Adifferent' }),
    (n) => ({ ...n, metadata: { ...n.metadata, logicalAddress: 'wrong-logical' } }),
    (n) => ({ ...n, data: { ...n.data, jobId: 'changed' } }),
    (n) => ({ ...n, createdByTx: 'f'.repeat(64) }),
  ];
  for (const mutate of mutations) {
    chain.faults.native = mutate;
    assert.notEqual(await a.adapter.verifyReceipt({ receipt: a.receipt, logicalAddress: logical, artifact: a.value, expectedWriter: a.writer }), 'valid');
  }
  chain.faults.native = null;
  for (const mutate of [
    (b) => ({ ...b, content: { ...b.content, ordered_transactions: [] } }),
    (b) => ({ ...b, validation_data: { ...b.validation_data, chainIdentity: 'f'.repeat(64) } }),
    (b) => ({ ...b, status: 'pending' }),
  ]) {
    chain.faults.block = mutate;
    await failure(a.adapter.read(logical, { expectedWriter: a.writer }), 'invalid');
  }
  chain.faults.block = null;
  chain.faults.tx = (tx) => ({ ...tx, status: 'pending' });
  await failure(a.adapter.read(logical, { expectedWriter: a.writer }), 'indeterminate');
  chain.faults.tx = null;
  chain.faults.chainIdentity = 'f'.repeat(64);
  await failure(a.adapter.read(logical, { expectedWriter: a.writer }), 'invalid-chain');
  chain.faults.chainIdentity = fixtureIdentity;
  for (const fault of ['unavailable', 'marker']) {
    chain.faults[fault] = fault !== 'marker';
    await failure(a.adapter.read(logical, { expectedWriter: a.writer }), 'indeterminate');
    assert.equal(await a.adapter.verifyReceipt({ receipt: a.receipt, logicalAddress: logical, artifact: a.value, expectedWriter: a.writer }), 'indeterminate');
    chain.faults[fault] = fault === 'marker';
  }
  chain.faults.search = () => [{ programName: 'bad' }];
  await failure(a.adapter.read(logical, { expectedWriter: a.writer }), 'indeterminate');
  chain.faults.search = (rows) => [...rows, { programName: 'dacs3%3Aagreement%3Aoffline-sr2-job', storageAddress: `stor-${'f'.repeat(40)}` }];
  await failure(a.adapter.read(logical, { expectedWriter: a.writer }), 'indeterminate');
  chain.faults.search = null;
  chain.faults.repeatPage = true;
  await failure(a.adapter.read(logical, { expectedWriter: a.writer }), 'indeterminate');
});

async function anchoredKind(chain, wallet, name, value, artifactKind) {
  const w = world(chain);
  const writer = claim(wallet);
  const plan = await w.adapter.planWrite({ logicalAddress: name, artifact: value, writer, artifactKind });
  const handoff = await w.adapter.takeWalletHandoff({ planId: plan.planId, walletAddress: wallet.address });
  const authorized = await w.adapter.authorizeWrite({ planId: plan.planId, walletAddress: wallet.address, writerSignature: wallet.signHex(handoff.request.params[0]) });
  await chain.submit(authorized.signedTransaction);
  const receipt = await w.adapter.write({ logicalAddress: name, artifact: value, writer, artifactKind, transactionHash: authorized.signedTransaction.hash });
  return { ...w, writer, value, receipt, authorized };
}
const unmarked = (code) => (error) => error.code === code && error.contradiction !== true;

// the source change (re-review r3, code P3-2): with no projection or retained embedded plan,
// read() authenticates the transaction the node names in createdByTx. Another
// real CREATE by the same writer, for another address, is not the writer's
// claim about this address: refused unmarked, never a contradiction.
test('a node-chosen createdByTx naming the same writer\'s CREATE for another address is refused unmarked', async (t) => {
  const chain = await startWireFixture(t);
  const wallet = createEphemeralWallet();
  const a = await anchored(chain, wallet);
  const other = await anchored(chain, wallet, shipped, 'dacs3:agreement:other-job', { ...artifact(), jobId: 'other-job' });
  chain.faults.native = (n) => (n.storageAddress === a.receipt.nativeAddress ? { ...n, createdByTx: other.txHash, interactionTxs: [other.txHash] } : n);
  await assert.rejects(world(chain).adapter.read(logical, { expectedWriter: a.writer }), unmarked('invalid'), 'fresh reader');
  await assert.rejects(a.adapter.read(logical, { expectedWriter: a.writer }), unmarked('invalid'), 'adapter holding the strict plan');
  // planWrite's own read before any plan exists (the wallet bridge's first anchor).
  await assert.rejects(world(chain).adapter.planWrite({ logicalAddress: logical, artifact: a.value, writer: a.writer }), unmarked('invalid'), 'planWrite before any plan');
  chain.faults.native = null;
  assert.equal((await world(chain).adapter.read(logical, { expectedWriter: a.writer })).status, 'present');
});

// the source change (re-review r3, code P3-3): the adapter's marks, each pinned. Under a
// projection the executed `from` is node data: refused unmarked, and the
// receipt check is indeterminate. A writer-signed CREATE of another kind than
// the caller pinned is the writer's contradiction: the receipt check is invalid.
test('a projected read with a node-altered executed from is unmarked; a signed CREATE of another kind is a contradiction', async (t) => {
  const chain = await startWireFixture(t);
  const wallet = createEphemeralWallet();
  const a = await anchoredKind(chain, wallet, logical, artifact(), 'Agreement');
  const { content, hash: txHash, signature } = a.authorized.signedTransaction;
  const signedProjection = { hash: txHash, content, signature };
  const check = (extra = {}) => world(chain).adapter.verifyReceipt({ receipt: a.receipt, logicalAddress: logical, artifact: a.value, expectedWriter: a.writer, artifactKind: 'Agreement', ...extra });
  assert.equal(await check({ signedProjection }), 'valid');
  chain.faults.tx = (tx) => ({ ...tx, content: { ...tx.content, from: createEphemeralWallet().address } });
  await assert.rejects(world(chain).adapter.read(logical, { expectedWriter: a.writer, signedProjection }), unmarked('invalid'));
  assert.equal(await check({ signedProjection }), 'indeterminate');
  chain.faults.tx = null;
  assert.equal(await check({ artifactKind: 'Listing' }), 'invalid');
  assert.equal(await check({ signedProjection, artifactKind: 'Listing' }), 'invalid');
  await assert.rejects(world(chain).adapter.read(logical, { expectedWriter: a.writer, expectedArtifactKind: 'Listing', signedProjection }), (error) => error.code === 'invalid' && error.contradiction === true);
  assert.equal(await check(), 'valid');
});

// the source change (final review, finding 2): read()'s own kind check (one mark with its
// delivery-scope check; an Agreement CREATE binds no delivery scope). The node
// chose the CREATE (createdByTx, no projection): another kind there is refused
// unmarked. The same CREATE pinned by the caller is the writer's contradiction.
test('read() refuses a node-chosen CREATE of another kind unmarked; pinned, it is a contradiction', async (t) => {
  const chain = await startWireFixture(t);
  const a = await anchoredKind(chain, createEphemeralWallet(), logical, artifact(), 'Agreement');
  const { content, hash: txHash, signature } = a.authorized.signedTransaction;
  const signedProjection = { hash: txHash, content, signature };
  const read = (extra) => world(chain).adapter.read(logical, { expectedWriter: a.writer, ...extra });
  const marked = (error) => error.code === 'invalid' && error.contradiction === true;
  assert.equal((await read({ expectedArtifactKind: 'Agreement' })).status, 'present');
  await assert.rejects(read({ expectedArtifactKind: 'Listing' }), unmarked('invalid'), 'node-chosen, another kind');
  await assert.rejects(read({ expectedArtifactKind: 'Listing', signedProjection }), marked, 'pinned, another kind');
  assert.equal((await read({ expectedArtifactKind: 'Agreement', signedProjection })).status, 'present');
});

// the source change (final review, finding 2): authenticate's own mark, without the live
// reader. The caller pins the writer's signed CREATE for another address (the
// node names that same transaction): its signature verifies and it binds
// another logical address, a contradiction. Node-chosen, it is refused unmarked.
test('authenticate marks a pinned writer-signed CREATE that binds another address; node-chosen it is unmarked', async (t) => {
  const chain = await startWireFixture(t);
  const wallet = createEphemeralWallet();
  const a = await anchored(chain, wallet);
  const other = await anchored(chain, wallet, shipped, 'dacs3:agreement:other-job', { ...artifact(), jobId: 'other-job' });
  const { content, hash, signature } = other.authorized.signedTransaction;
  chain.faults.native = (n) => (n.storageAddress === a.receipt.nativeAddress ? { ...n, createdByTx: other.txHash, interactionTxs: [other.txHash] } : n);
  await assert.rejects(world(chain).adapter.read(logical, { expectedWriter: a.writer, signedProjection: { hash, content, signature } }),
    (error) => error.code === 'invalid' && error.contradiction === true && /does not bind the logical address/.test(error.message));
  await assert.rejects(world(chain).adapter.read(logical, { expectedWriter: a.writer }), unmarked('invalid'));
  chain.faults.native = null;
  assert.equal((await world(chain).adapter.read(logical, { expectedWriter: a.writer })).status, 'present');
});

// the source change (re-review r3, code P3-1 / a review P3-1): verifyReceipt's verdict is
// shared by every caller. The seller's Agreement consumer reads cleanly; node
// junk only at its receipt check's own read is now `indeterminate` (held),
// where main answered `rejected`. Its first read keeps its codes.
test('the seller Agreement consumer holds, never rejects, on node junk at its receipt check alone', async (t) => {
  const chain = await startWireFixture(t);
  const a = await anchoredKind(chain, createEphemeralWallet(), logical, artifact(), 'Agreement');
  const second = (fault) => { let n = 0; return (value) => (++n === 2 ? fault(value) : value); };
  const readAgreement = () => createSellerSr2AgreementAnchor({ reader: world(chain).adapter }).readAgreement({ logicalAddress: logical, writer: a.writer });
  assert.equal((await readAgreement()).disposition, 'present');
  for (const [label, install] of [
    ['block pending', () => { chain.faults.block = second((b) => ({ ...b, status: 'pending' })); }],
    ['transaction without content', () => { chain.faults.tx = second(({ content, ...rest }) => rest); }],
    ['native metadata names another kind', () => { chain.faults.native = second((p) => ({ ...p, metadata: { ...p.metadata, artifactKind: 'Listing' } })); }],
  ]) {
    install();
    const read = await readAgreement();
    chain.faults.block = null; chain.faults.tx = null; chain.faults.native = null;
    assert.deepEqual([read.disposition, read.reason], ['indeterminate', 'SR-2 Agreement receipt is indeterminate'], label);
  }
  assert.equal((await readAgreement()).disposition, 'present');
});

// the source change (final review, finding 3): native payment evidence, a caller of read().
// Node junk at its read holds (`indeterminate`); only the adapter's marked
// contradiction (the seller's pinned signed CREATE binds another kind) is
// `rejected`, with the consumer's existing codes. (The seller Agreement
// consumer's first read keeps its codes: see the test above.)
test('the native payment-evidence read holds on node junk; only a marked contradiction rejects', async (t) => {
  const chain = await startWireFixture(t);
  chain.faults.marker = true;
  const wallet = createEphemeralWallet(), writer = claim(wallet), jobId = 'offline-sr2-evidence-job';
  const agreement = { jobId, listingRef: {}, parties: [{ role: 'buyer', primaryClaim: claim(createEphemeralWallet()) }, { role: 'seller', primaryClaim: writer }],
    terms: { price: { amount: '1', currency: 'DEM' }, deadline: 1791144400000, payoutBindings: [{ payeeAddress: wallet.address, phaseIndex: 0, railId: 'pay-dem' }] } };
  const { paymentEvidenceAddress } = await import('@kynesyslabs/dacs');
  const address = paymentEvidenceAddress(jobId, 'pay-dem', 0);
  // The seller's own signed CREATE at the evidence address, of another kind.
  const a = await anchoredKind(chain, wallet, address, { ...artifact(), jobId }, 'Agreement');
  const { content, hash, signature } = a.authorized.signedTransaction;
  let projection;
  const consumer = createNativePaymentEvidenceConsumer({ rpcUrl: chain.url, readSignedProjection: async () => projection });
  const readEvidence = () => consumer.readEvidence({ agreement, writer, txHash: 'a'.repeat(64), blockNumber: 1, committedAt: 1 });
  for (const [label, install] of [
    ['block pending', () => { chain.faults.block = (b) => ({ ...b, status: 'pending' }); }],
    ['transaction without content', () => { chain.faults.tx = ({ content: dropped, ...rest }) => rest; }],
    ['node-chosen CREATE of another kind', () => {}],
  ]) {
    install();
    const read = await readEvidence();
    chain.faults.block = null; chain.faults.tx = null;
    assert.deepEqual([read.disposition, read.nativeReadStatus, read.code], ['indeterminate', 'invalid', 'invalid'], `${label}: ${read.reason}`);
  }
  projection = { hash, content, signature };
  const contradicted = await readEvidence();
  assert.deepEqual([contradicted.disposition, contradicted.nativeReadStatus, contradicted.code, contradicted.reason], ['rejected', 'invalid', 'invalid', 'native readback binds another artifact kind']);
});

test('name resolution rejects ambiguous owned records and ignores another owner without inventing a native address', async (t) => {
  const chain = await startWireFixture(t);
  const wrongOwner = await anchored(chain);
  const target = await anchored(chain, createEphemeralWallet());
  const reader = world(chain).adapter;
  const found = await reader.read(logical, { expectedWriter: target.writer });
  assert.equal(found.receipt.nativeAddress, target.receipt.nativeAddress);
  assert.notEqual(found.receipt.nativeAddress, wrongOwner.receipt.nativeAddress);
  const existing = await reader.planWrite({ logicalAddress: logical, artifact: target.value, writer: target.writer });
  assert.equal(existing.stage, 'verified', 'a fresh journal adopts only authenticated existing content');
  await failure(reader.takeWalletHandoff({ planId: existing.planId, walletAddress: target.wallet.address }), 'handoff-already-issued');
  assert.equal((await reader.read(logical, { expectedWriter: target.writer })).receipt.nativeAddress, target.receipt.nativeAddress);
  assert.equal(await reader.write({ logicalAddress: logical, artifact: target.value, writer: target.writer, transactionHash: target.txHash }).then((r) => r.nativeAddress), target.receipt.nativeAddress);
  await failure(reader.read(logical), 'writer-required');
  const absent = await reader.read(logical, { expectedWriter: createEphemeralWallet().claim });
  assert.equal(absent.status, 'absent');
  const duplicate = clone(target.authorized.signedTransaction);
  duplicate.content.nonce = 2;
  duplicate.content.to = addressFrom(target.wallet.address, duplicate.content.data[1].programName, 2);
  duplicate.content.data[1].storageAddress = duplicate.content.to;
  duplicate.hash = digest(JSON.stringify(duplicate.content));
  duplicate.signature.data = target.wallet.signHex(duplicate.hash);
  await chain.submit(duplicate);
  await failure(reader.read(logical, { expectedWriter: target.writer }), 'indeterminate');
});

test('unknown outcome, index lag, adapter restart and concurrent retry issue no second irreversible handoff', async (t) => {
  const chain = await startWireFixture(t);
  const buyer = createEphemeralWallet();
  const w = world(chain);
  const value = artifact();
  const requests = await Promise.all(Array.from({ length: 5 }, () => w.adapter.planWrite({ logicalAddress: logical, artifact: value, writer: buyer.claim })));
  assert.equal(new Set(requests.map((r) => r.planId)).size, 1);
  const p = requests[0];
  const handoffs = await Promise.allSettled(Array.from({ length: 4 }, () => w.adapter.takeWalletHandoff({ planId: p.planId, walletAddress: buyer.address })));
  assert.equal(handoffs.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(handoffs.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'handoff-already-issued'));
  const h = handoffs.find((r) => r.status === 'fulfilled').value;
  const authorized = await w.adapter.authorizeWrite({ planId: p.planId, walletAddress: buyer.address, writerSignature: buyer.signHex(h.request.params[0]) });
  chain.faults.dropAfterApply = true;
  await assert.rejects(chain.submit(authorized.signedTransaction), /fetch failed/);
  chain.faults.dropAfterApply = false;
  assert.equal(chain.accepted(), 1);
  chain.faults.unavailable = true;
  await failure(w.adapter.write({ logicalAddress: logical, artifact: value, writer: buyer.claim, transactionHash: authorized.signedTransaction.hash }), 'indeterminate');
  await failure(w.adapter.planWrite({ logicalAddress: 'dacs4:another', artifact: value, writer: buyer.claim }), 'indeterminate');
  chain.faults.unavailable = false;
  await failure(w.adapter.planWrite({ logicalAddress: 'dacs4:another', artifact: value, writer: buyer.claim }), 'wallet-fenced');
  chain.faults.indexLag = true;
  const restored = shipped.createInMemoryDemosSr2Journal(JSON.parse(JSON.stringify(w.journal.records())));
  const restarted = world(chain, shipped, restored);
  const replay = await restarted.adapter.planWrite({ logicalAddress: logical, artifact: value, writer: buyer.claim });
  assert.equal(replay.nativeAddress, p.nativeAddress);
  assert.equal(replay.nonce, 1);
  await failure(restarted.adapter.takeWalletHandoff({ planId: p.planId, walletAddress: buyer.address }), 'handoff-already-issued');
  await failure(restarted.adapter.authorizeWrite({ planId: p.planId, walletAddress: buyer.address, writerSignature: buyer.signHex(h.request.params[0]) }), 'authorization-already-issued');
  const receipt = await restarted.adapter.write({ logicalAddress: logical, artifact: value, writer: buyer.claim, transactionHash: authorized.signedTransaction.hash });
  assert.equal(receipt.nativeAddress, p.nativeAddress);
  assert.equal((await restarted.adapter.read(logical, { expectedWriter: buyer.claim })).status, 'present');
  await restarted.adapter.write({ logicalAddress: logical, artifact: value, writer: buyer.claim, transactionHash: authorized.signedTransaction.hash });
  assert.equal((await chain.duplicate(authorized.signedTransaction)).result, 400, 'the fixture independently refuses replay of the consumed nonce');
  assert.equal(chain.accepted(), 1);
  assert.equal(chain.nonces.get(buyer.address), 1);
  assert.equal(chain.calls.filter((c) => c === 'execute:broadcastTx').length, 2, 'one simulated submission plus one deliberate replay-rejection witness');
});

test('offline endpoint, timestamp and artifact boundaries fail before writes', async (t) => {
  const chain = await startWireFixture(t);
  for (const rpcUrl of ['https://node2.demos.sh', 'http://localhost:1', 'http://127.0.0.1:1/path', 'http://user@127.0.0.1:1', 'http://127.0.0.1:1/?q=1']) {
    assert.throws(() => shipped.createDemosSr2Adapter({ rpcUrl, journal: shipped.createInMemoryDemosSr2Journal() }), (e) => e.code === 'offline-only');
  }
  assert.throws(() => shipped.createDemosSr2Adapter({ rpcUrl: chain.url }), (e) => e.code === 'journal-required');
  const w = world(chain);
  const wallet = createEphemeralWallet();
  await failure(w.adapter.planWrite({ logicalAddress: 'x'.repeat(257), artifact: artifact(), writer: wallet.claim }), 'invalid');
  await failure(w.adapter.planWrite({ logicalAddress: logical, artifact: { value: 'x'.repeat(65536) }, writer: wallet.claim }), 'invalid');
  await failure(w.adapter.planWrite({ logicalAddress: logical, artifact: artifact(), writer: wallet.claim, receiptContentHash: 'F'.repeat(64) }), 'invalid');
  const badClock = shipped.createDemosSr2Adapter({ rpcUrl: chain.url, journal: shipped.createInMemoryDemosSr2Journal(), now: () => -1 });
  await failure(badClock.planWrite({ logicalAddress: logical, artifact: artifact(), writer: wallet.claim }), 'invalid');
  assert.equal(chain.accepted(), 0);
});

// Repeatable test-effectiveness witnesses: disposable in-memory source copies
// retain the accepting control. No repository files or shared state are edited.
async function mutant(before, after) {
  const url = new URL('../src/dacs/demos-sr2-adapter.mjs', import.meta.url);
  let source = readFileSync(url, 'utf8');
  assert.equal(source.split(before).length, 2, 'mutation must have one exact target');
  source = source.replace(before, after).replace(/from '([^']+)'/g, (_, specifier) => {
    const resolved = specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier);
    return `from '${resolved}'`;
  });
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('guard witnesses: wallet signature and block inclusion mutants accept controls but expose the independent negative cases', async (t) => {
  const variants = [
    { before: '!verifyDemosSignature({ address: owner, message: txHash, signature: tx.signature.data })', after: 'false',
      fault: (c) => { c.faults.tx = (tx) => ({ ...tx, signature: { type: 'ed25519', data: `0x${'0'.repeat(128)}` } }); } },
    { before: '!block.content.ordered_transactions.includes(txHash)', after: 'false',
      fault: (c) => { c.faults.block = (b) => ({ ...b, content: { ...b.content, ordered_transactions: [] } }); } },
  ];
  for (const variant of variants) {
    const chain = await startWireFixture(t);
    const module = await mutant(variant.before, variant.after);
    const a = await anchored(chain, createEphemeralWallet(), module);
    assert.equal((await a.adapter.read(logical, { expectedWriter: a.writer })).status, 'present', 'mutant retains accepting control');
    variant.fault(chain);
    const normal = world(chain).adapter;
    await failure(normal.read(logical, { expectedWriter: a.writer }), 'invalid');
    assert.equal((await a.adapter.read(logical, { expectedWriter: a.writer })).status, 'present', 'same negative is wrongly accepted when its guard is removed');
  }
});
