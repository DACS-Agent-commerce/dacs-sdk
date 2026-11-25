// The keyless signed relay: a registered Agreement transport that confirms and broadcasts what the buyer's own wallet
// signed. The real transport, effect boundary and durable journal run in this process against a scripted TEST node;
// the buyer's wallet is a throwaway ed25519 key made here, never handed to the relay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { api, setPurchaseAdmission, T0, world } from './helpers/tp1-node-fixture.mjs';
import { installPackedPair } from './helpers/packed-install.mjs';

// Loaded after the fixture's admission hook, so the relay sees the admission double.
const { createKeylessSignedRelayTransport } = await import('../src/wallet/keyless-agreement-transport.mjs');
const { buildNativeTransferPayload, deriveStorageAddress } = await import('../src/dacs/wallet-transactions.mjs');

const CEILING = '50000000000';
const PAYEE = '0x' + '7'.repeat(64);
const PUBLIC_ORIGIN = 'https://relay.example.invalid';
const AMOUNT_OS = '2500000000';
const FEE_OS = '1000000000';
const live = Object.freeze({ currentAuthorization: () => true });
const sha = value => createHash('sha256').update(value).digest('hex');
const execute = (extra, data) => ({ method: 'execute', params: [{ extra, data }] });
const code = expected => error => error?.code === expected;

// The buyer's wallet: it signs its own transactions and RPC authentication headers.
function buyerWallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const address = '0x' + Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  const signText = message => sign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex');
  let stamp = Date.now();
  const headers = () => {
    const identity = `ed25519:${address}`, timestamp = String(stamp++);
    return { identity, timestamp, signature: signText(sha(`${identity}:${timestamp}`)) };
  };
  const signed = content => { const hash = sha(JSON.stringify(content)); return { content, signature: { type: 'ed25519', data: signText(hash) }, hash, status: '', blockNumber: null }; };
  return { address, headers, signed };
}

// A native payment of AMOUNT_OS to PAYEE with FEE_OS network and rpc fees, signed by the buyer.
function signedPayment(buyer, nonce) {
  const content = structuredClone(buildNativeTransferPayload({ from: buyer.address, to: PAYEE, amountOs: AMOUNT_OS, nonce, timestamp: T0, encoding: 'os-string' }).content);
  const edit = (type, operation, account, amount) => ({ type, operation, isRollback: false, account, txhash: '', amount });
  Object.assign(content, { from: buyer.address, from_ed25519_address: buyer.address, nonce,
    transaction_fee: { network_fee: FEE_OS, rpc_fee: FEE_OS, additional_fee: '0', rpc_address: null },
    gcr_edits: [edit('balance', 'remove', buyer.address, content.amount), edit('balance', 'add', content.to, content.amount),
      edit('balance', 'remove', buyer.address, FEE_OS), edit('nonce', 'add', buyer.address, 1)] });
  return buyer.signed(content);
}

// An Agreement storage CREATE under the relay's own network binding, signed by the buyer.
function signedAgreementCreate(buyer, nonce, networkBinding) {
  const jobId = '01M5YKPJG0248H248H248H248H', logicalAddress = 'dacs3:agreement:' + jobId, artifact = { jobId, note: 'TEST-agreement' };
  const contentHash = sha256Hex(canonicalize(artifact)), programName = logicalAddress.replace(/:/g, '%3A');
  const storageAddress = deriveStorageAddress(buyer.address, programName, nonce, '');
  const operation = { operation: 'CREATE_STORAGE_PROGRAM', programName, storageAddress, salt: '', encoding: 'json', storageLocation: 'onchain', acl: { mode: 'public' },
    data: artifact, metadata: { logicalAddress, contentHash, envelopeHash: contentHash, artifactKind: 'Agreement', networkBinding } };
  return buyer.signed({ type: 'storageProgram', from: buyer.address, to: storageAddress, amount: 0, data: ['storageProgram', operation], nonce, timestamp: T0,
    transaction_fee: { network_fee: 0, rpc_fee: 0, additional_fee: 0, rpc_address: null }, network: networkBinding.network, chainIdentity: networkBinding.chainIdentity });
}

// A world with no wallet session: the fixture's session slot holds only the buyer's public address. `hooks.onContext` runs
// once on the owner's next getContext call, which a send makes after the facade's entry check and before any node request.
async function relayWorld(t, { feeCeilingOs = CEILING } = {}) {
  const buyer = buyerWallet(), hooks = { onContext: null }, state = { stopped: false };
  const publicOnly = async () => ({ wallet: { getPublicAccount: () => ({ address: buyer.address }) }, close: async () => {} });
  const ownerWrap = owner => Object.freeze({ ...owner, getContext: () => {
    const once = hooks.onContext;
    hooks.onContext = null;
    once?.();
    return owner.getContext();
  } });
  const w = await world(t, { createSession: publicOnly, ownerWrap });
  let current = { owner: w.owner, admission: w.admission };
  const open = async () => {
    const relay = await createKeylessSignedRelayTransport({ admission: current.admission, owner: current.owner, journal: w.journal(), stopped: () => state.stopped, feeCeilingOs });
    t.after(() => relay.nativeTransport.close());
    return relay;
  };
  const r = { w, buyer, hooks, state, relay: await open() };
  const transport = () => r.relay.nativeTransport;
  const bindingCall = request => transport().walletBinding(request, buyer.headers());
  Object.assign(r, {
    lease: async () => {
      const { binding } = await bindingCall({ phase: 'bind', address: buyer.address });
      return bindingCall({ phase: 'signature', address: buyer.address, binding });
    },
    confirm: (tx, relayOptions = live) => transport().rpc(execute('confirmTx', tx), buyer.headers(), relayOptions),
    prepareBroadcast: (leaseId, hash) => bindingCall({ phase: 'broadcast', address: buyer.address, leaseId, hash }),
    broadcast: (confirmation, relayOptions = live) => transport().rpc(execute('broadcastTx', confirmation), buyer.headers(), relayOptions),
    readback: hash => transport().binding({ phase: 'readback', address: buyer.address, hash }),
    sends: extra => w.node.calls.filter(call => call.body?.method === 'execute' && call.body.params[0].extra === extra).length,
    networkBinding: () => api.keylessAgreementProfile({ binding: current.admission.binding, publicOrigin: PUBLIC_ORIGIN }).transportBinding,
    restart: async () => { await r.relay.nativeTransport.close(); current = await w.restart(); r.relay = await open(); },
  });
  return r;
}

// Leases, confirms and makes ready to broadcast one signed transaction through the relay.
async function readyToBroadcast(r, tx) {
  const lease = await r.lease();
  const confirmation = await r.confirm(tx);
  await r.prepareBroadcast(lease.leaseId, tx.hash);
  return confirmation;
}

test('the signed relay is exported from the packed package root and its native transport is registered as an Agreement transport', t => {
  const { app, run } = installPackedPair(t);
  writeFileSync(join(app, 'signed-relay.mjs'), `
    import assert from 'node:assert/strict';
    import { tmpdir } from 'node:os';
    import { mkdtempSync } from 'node:fs';
    import { join } from 'node:path';
    import { bindTp1Profile, TP1_APPROVED_IDENTITY_RECORD as record } from '@kynesyslabs/dacs/wire';
    import { createKeylessSignedRelayTransport } from '@kynesyslabs/dacs-client';
    import { createNodeTransportOwner, isDevnetAgreementTransport, isDevnetSettlementTransport } from '@kynesyslabs/dacs-client/node-wallet';
    import { openDurableWalletJournal } from '@kynesyslabs/dacs-client/wallet/durable-journal';
    const owner = createNodeTransportOwner({ endpoint: 'https://rpc.example.invalid/', transportAuthority: 'vector-authority', fetchImpl: () => { throw new Error('TEST-no-network'); } });
    const binding = await bindTp1Profile({ record, local: owner.currentLocal(), readAuthority: async scope => ({ local: { ...scope.local },
      chainIdentity: record.chainIdentity, provenance: 'TEST-authority', sessionId: scope.sessionId, participants: [] }) });
    const journal = openDurableWalletJournal({ path: join(mkdtempSync(join(tmpdir(), 'signed-relay-')), 'journal.sqlite'), mode: 'create' });
    const relay = await createKeylessSignedRelayTransport({ admission: { binding, currentLocal: owner.currentLocal }, owner, journal, stopped: () => false, feeCeilingOs: '${CEILING}' });
    assert.deepEqual(Object.keys(relay), ['nativeTransport']);
    assert.equal(isDevnetAgreementTransport(relay.nativeTransport), true);
    assert.equal(isDevnetSettlementTransport(relay.nativeTransport), false);
    await relay.nativeTransport.close(); journal.close(); owner.close();
  `);
  run(process.execPath, ['signed-relay.mjs'], app);
});

test('the signed relay takes no key option, exposes no signing member and cannot sign for a wallet whose bytes it relays', async t => {
  const r = await relayWorld(t);
  const { owner, admission } = r.w;
  const base = { admission, owner, journal: r.w.journal(), stopped: () => false, feeCeilingOs: CEILING };
  const keyOptions = { key: new Uint8Array(32), mnemonic: 'TEST words', keystorePath: '/TEST/keystore.json', passphrase: 'TEST-passphrase', signer: () => {},
    signRpc: () => {}, wallet: {}, boundary: {}, reopenGrants: {}, fetchImpl: () => {} };
  for (const [name, value] of Object.entries(keyOptions)) {
    await assert.rejects(createKeylessSignedRelayTransport({ ...base, [name]: value }), error => error instanceof TypeError && error.message === 'keyless_relay_options_invalid', name);
  }
  assert.deepEqual(Object.keys(r.relay), ['nativeTransport']);
  for (const name of ['key', 'wallet', 'signer', 'signRpc', 'signPass', 'signerFor', 'signAuthentication', 'boundary', 'effectBoundary', 'reopenWithheldBroadcast', 'recoverStorageWrite']) {
    assert.equal(name in r.relay.nativeTransport, false, name);
  }
  // Bytes whose signature is not the sender's own are refused before the node sees a confirmation.
  await r.lease();
  const tx = signedPayment(r.buyer, 1), forged = { ...tx, signature: { type: 'ed25519', data: signedPayment(buyerWallet(), 1).signature.data } };
  await assert.rejects(r.confirm(forged), code('native_only'));
  assert.equal(r.sends('confirmTx'), 0);
});

test('an execute send without the relay check is refused before the node sees it, and a preparation read needs none', async t => {
  const r = await relayWorld(t);
  await r.lease();
  const tx = signedPayment(r.buyer, 1);
  for (const extra of ['confirmTx', 'broadcastTx']) {
    await assert.rejects(r.relay.nativeTransport.rpc(execute(extra, tx), r.buyer.headers()), error => error instanceof TypeError && error.message === 'relay_authorization_required', extra);
  }
  assert.equal(r.sends('confirmTx'), 0);
  const read = await r.relay.nativeTransport.rpc({ method: 'nodeCall', params: [{ message: 'getAddressNonce', data: { address: r.buyer.address } }] }, r.buyer.headers());
  assert.equal(read.result, 200);
});

// Each gate changes during the send, after the facade's entry check, so the refusal comes from the check made before the first byte.
const GATES = [
  ['a binding that is no longer current', 'tp1_connection_unverified', r => { r.w.authority.state.provenance = 'TEST-authority-moved'; }],
  ['a lost admission', 'profile_not_admitted', () => setPurchaseAdmission('held')],
  ['a set stop', 'writes_stopped', r => { r.state.stopped = true; }],
];
for (const [label, refusal, close] of GATES) {
  test(`${label} sends no confirmation and no broadcast bytes and refuses ${refusal}`, async t => {
    const confirming = await relayWorld(t);
    await confirming.lease();
    confirming.hooks.onContext = () => close(confirming);
    await assert.rejects(confirming.confirm(signedPayment(confirming.buyer, 1)), code(refusal), 'confirmTx');
    assert.equal(confirming.sends('confirmTx'), 0);

    // A new world admits purchase actions again.
    const broadcasting = await relayWorld(t), tx = signedPayment(broadcasting.buyer, 1), confirmation = await readyToBroadcast(broadcasting, tx);
    broadcasting.hooks.onContext = () => close(broadcasting);
    await assert.rejects(broadcasting.broadcast(confirmation), code(refusal), 'broadcastTx');
    assert.equal(broadcasting.sends('broadcastTx'), 0);
  });
}

test('a debit over the fee ceiling sends no confirmation or no broadcast bytes and refuses write-fee-cap', async t => {
  // Below the amount: the confirmation is refused. Above the amount but below amount plus fees: the broadcast is refused.
  const confirming = await relayWorld(t, { feeCeilingOs: '1000' });
  await confirming.lease();
  await assert.rejects(confirming.confirm(signedPayment(confirming.buyer, 1)), code('write-fee-cap'));
  assert.equal(confirming.sends('confirmTx'), 0);

  const broadcasting = await relayWorld(t, { feeCeilingOs: String(BigInt(AMOUNT_OS) + BigInt(FEE_OS)) });
  const confirmation = await readyToBroadcast(broadcasting, signedPayment(broadcasting.buyer, 1));
  await assert.rejects(broadcasting.broadcast(confirmation), code('write-fee-cap'));
  assert.equal(broadcasting.sends('broadcastTx'), 0);
});

test('a buyer-signed native payment is confirmed once and broadcast once through the relay', async t => {
  const r = await relayWorld(t), tx = signedPayment(r.buyer, 1);
  const confirmation = await readyToBroadcast(r, tx);
  assert.equal(confirmation.response.data.valid, true);
  const answer = await r.broadcast(confirmation);
  assert.equal(answer.result, 200);
  assert.equal(r.sends('confirmTx'), 1);
  assert.equal(r.sends('broadcastTx'), 1);
  assert.deepEqual(r.w.node.broadcasts.map(sent => sent.hash), [tx.hash]);
  assert.deepEqual(r.w.node.broadcasts[0], tx, 'the node receives the exact signed bytes');
});

test('a buyer-signed Agreement CREATE is confirmed once and broadcast once through the relay', async t => {
  const r = await relayWorld(t), tx = signedAgreementCreate(r.buyer, 1, r.networkBinding());
  const confirmation = await readyToBroadcast(r, tx);
  const answer = await r.broadcast(confirmation);
  assert.equal(answer.result, 200);
  assert.equal(r.sends('confirmTx'), 1);
  assert.equal(r.sends('broadcastTx'), 1);
  assert.deepEqual(r.w.node.broadcasts, [tx]);
});

test('a broadcast whose answer is lost is journaled, is never sent again, also after a restart, and is read back as included', async t => {
  const r = await relayWorld(t), tx = signedPayment(r.buyer, 1), confirmation = await readyToBroadcast(r, tx);
  r.w.node.mode = 'drop';
  await assert.rejects(r.broadcast(confirmation));
  r.w.node.mode = 'accept';
  assert.equal((await r.w.lane()).stage, 'broadcast-started', 'the lane keeps the send whose outcome is unknown');
  // The send ended its lease, and the retained lane refuses every new lease for the wallet, so the bytes cannot be confirmed or sent again.
  await assert.rejects(r.broadcast(confirmation), code('network_binding_required'));
  await assert.rejects(r.lease(), code('outcome_unknown'));

  await r.restart();
  await assert.rejects(r.lease(), code('outcome_unknown'));
  await assert.rejects(r.broadcast(confirmation), code('network_binding_required'));
  const read = await r.readback(tx.hash);
  assert.equal(read.disposition, 'included', JSON.stringify(read));
  assert.equal(r.sends('broadcastTx'), 1, 'one broadcast in all');
});

test("the keyless readback view still refuses every execute send while a signed relay shares its owner and journal, and the node-wallet facade is the relay's own", async t => {
  const r = await relayWorld(t);
  const view = await api.createKeylessAgreementTransport({ admission: r.w.admission, owner: r.w.owner, journal: r.w.journal(), walletAddress: r.buyer.address });
  t.after(() => view.close());
  const tx = signedPayment(r.buyer, 1);
  for (const extra of ['confirmTx', 'broadcastTx']) {
    await assert.rejects(view.rpc(execute(extra, tx), r.buyer.headers()), error => error.message === 'keyless_transport_write_refused', extra);
  }
  assert.equal(r.w.node.calls.filter(call => call.body?.method === 'execute').length, 0);
  const { createHeldTransportFacade } = await import('../src/wallet/held-transport-facade.mjs');
  assert.equal(api.createHeldTransportFacade, createHeldTransportFacade);
});
