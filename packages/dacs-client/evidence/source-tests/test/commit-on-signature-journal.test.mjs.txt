// Real broker route and Ed25519 CREATE, with an authenticated-session fixture.
// No wallet broadcast or seller request: durable retention is checked at notification.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { createOfflineAgreementBroker } from '../src/portal/offline-agreement-broker.mjs';
import { OFFLINE_AGREEMENT_PROFILE } from '../src/dacs/protocol-purchases.mjs';
import { DEMOS_SR2_FIXTURE_CHAIN_IDENTITY } from '../src/dacs/demos-sr2-adapter.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';

test('offline broker retains the exact approved CREATE before notifying; a failed durable write never notifies', async t => {
  const buyer = createEphemeralWallet(), rows = new Map(); let failWrite = false, notified = 0;
  const op = { id: 'purchase', accountId: 'account', kind: 'purchase', status: 'agreement_pending', expiresAt: new Date(Date.now() + 60000).toISOString(), termsHash: 'terms',
    terms: { buyer: { wallet: buyer.address }, domain: { network: 'fixture', mode: 'simulated-fixture' }, protocol: { profile: OFFLINE_AGREEMENT_PROFILE, jobId: 'job' } },
    state: { protocol: { stage: 'agreement-signing', planned: { plan: { agreementHash: 'a'.repeat(64) } } } } };
  const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const broker = createOfflineAgreementBroker({ config: { commitOnSignature: true, allowInsecureLocal: true, publicOrigin: origin, chain: { network: 'fixture', rpcUrl: origin }, embeddedWallet: { writes: 'simulated-loopback' } },
    ops: { getByHandoff: () => op, get: () => op }, accounts: { walletOwner: () => 'account' },
    challenges: { verifyAndConsume() {} },
    journal: { get: async key => rows.get(key), entries: () => [...rows], withWalletLock: async (_, work) => work(), put: async (key, value) => {
      await new Promise(resolve => setImmediate(resolve));
      if (failWrite) throw Error('TEST durable store unavailable');
      rows.set(key, structuredClone(value));
    } } });
  const app = express(); app.use(broker.router); server.on('request', app);
  const post = async (part, body) => { const res = await fetch(`${origin}/portal/api/purchase/purchase/browser-agreement/${part}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, ...await res.json() }; };
  const session = await post('session', { token: 'handoff', challengeId: 'authenticated', signature: 'authenticated' }); assert.equal(session.status, 200);
  const storage = { operation: 'CREATE_STORAGE_PROGRAM', programName: 'program', metadata: { artifactKind: 'Agreement' }, data: { exact: 'Agreement' } };
  const content = { from: buyer.address, to: 'storage', type: 'storageProgram', data: ['storageProgram', storage], nonce: 1, timestamp: Date.now(), amount: 0,
    network: 'fixture', chainIdentity: DEMOS_SR2_FIXTURE_CHAIN_IDENTITY, transaction_fee: { network_fee: 0, rpc_fee: 0, additional_fee: 0, rpc_address: null } };
  const request = { kind: 'CREATE', transaction: { content: structuredClone(content) } };
  const queued = { binding: session.scope, stage: 'issued-to-browser', expiresAt: Date.now() + 60000, request: { params: [request] }, correlation: 'correlation', requestHash: 'request-hash' };
  rows.set('browser-agreement/create/purchase', queued);
  content.from_ed25519_address = buyer.address;
  content.gcr_edits = [
    { type: 'balance', operation: 'remove', isRollback: false, account: buyer.address, txhash: '', amount: '1' },
    { type: 'storageProgram', target: content.to, isRollback: false, txhash: '', context: { operation: 'CREATE_STORAGE_PROGRAM', sender: buyer.address, data: { variables: structuredClone(storage), metadata: structuredClone(storage.metadata) } } },
    { type: 'balance', operation: 'remove', isRollback: false, account: buyer.address, txhash: '', amount: '1' },
    { type: 'nonce', operation: 'add', isRollback: false, account: buyer.address, txhash: '', amount: 1 } ];
  const hash = sha256Hex(JSON.stringify(content));
  const signedTransaction = { content, hash, signature: { type: 'ed25519', data: buyer.signHex(hash) }, status: '', blockNumber: null };
  const lane = JSON.stringify(['fixture', DEMOS_SR2_FIXTURE_CHAIN_IDENTITY, buyer.address]), key = `sr2/wallet/${lane}`;
  const storageBytes = Buffer.byteLength(canonicalize(storage.data));
  const record = { lane, stage: 'broadcast-started', nonce: 1, hash, signedTransaction, approved: { ...request, storageAddress: content.to, programName: storage.programName, nonce: 1, storageBytes,
    storageFeeOs: String(BigInt(Math.max(1, Math.ceil(storageBytes / 10240))) * 1_000_000_000n), exactCreate: canonicalize(storage), exactStorageBytes: canonicalize(storage.data), data: canonicalize(content.data) } };
  const body = { sessionToken: session.sessionToken, correlation: queued.correlation, requestHash: queued.requestHash, key: lane, record };
  broker.walletAgreement.onCreateAuthorized('purchase', projection => { assert.deepEqual(rows.get(key), record, 'notification must follow durable exact retention'); assert.deepEqual(projection, signedTransaction); notified++; });
  failWrite = true;
  assert.equal((await post('journal/put', body)).status, 409); assert.equal(notified, 0); assert.equal(rows.has(key), false);
  failWrite = false;
  assert.equal((await post('journal/put', body)).status, 200); assert.equal(notified, 1); assert.deepEqual(rows.get(key), record);
});
