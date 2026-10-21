// Embedded wallet transactions with the REAL upstream @kynesyslabs/demosdk
// 4.0.16 (installed in wallet-build/): sdk-provider.mjs signs, confirms and
// broadcasts through the plugin server's same-origin relay
// (/portal/api/wallet-rpc, simulated-loopback profile) to a SIMULATED loopback
// Demos node that verifies hash, Ed25519 signature, request auth and nonce
// independently of the SDK. Settlement and identity state are decided only by
// the plugin server's own chain readback. Functional offline tests: not a
// security review, not browser, installed-wallet or live-network proof.
// Every key is fresh and in memory; secrets are only compared with assert.ok.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

import { loadConfig, ConfigError } from '../src/config.mjs';
import { startHarness } from './helpers/harness.mjs';
import { tool, seedSellerListing, linkedUser } from './helpers/flows.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { createSdkWalletSession } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { startSdkChainFixture } from './helpers/embedded-wallet-transaction-chain.mjs';

const buildDir = new URL('../wallet-build/', import.meta.url);
const sdkDir = new URL('node_modules/@kynesyslabs/demosdk/', buildDir);
const SDK_BLOCKED = existsSync(new URL('package.json', sdkDir)) ? false : 'BLOCKED: wallet-build dependencies are not installed';

// Same resolution shim as embedded-wallet-sdk.test.mjs: the published 4.0.16
// build uses bundler-style specifiers; only importers inside the installed SDK
// get dir/ -> dir/index.js and ./x -> ./x.js. SDK bytes load unmodified.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!context.parentURL?.startsWith(sdkDir.href)) throw error;
      if (error?.code === 'ERR_UNSUPPORTED_DIR_IMPORT' && error.url) return nextResolve(new URL('index.js', error.url.endsWith('/') ? error.url : `${error.url}/`).href, context);
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.[cm]?js$/.test(specifier)) return nextResolve(`${specifier}.js`, context);
      throw error;
    }
  },
});

async function loadSdk() {
  const require = createRequire(new URL('package.json', buildDir));
  assert.equal(JSON.parse(readFileSync(new URL('package.json', sdkDir), 'utf8')).version, '4.0.16');
  const { Demos } = await import(pathToFileURL(require.resolve('@kynesyslabs/demosdk/websdk')).href);
  const { Identities } = await import(new URL('build/abstraction/Identities.js', sdkDir).href);
  const { validateMnemonic: bip39Validate } = await import(pathToFileURL(require.resolve('@scure/bip39')).href);
  const { wordList } = await import(new URL('build/encryption/PQC/falconts/wordlist.js', sdkDir).href);
  return { Demos, Identities, validateMnemonic: (m) => typeof m === 'string' && bip39Validate(m, wordList) };
}

const sdk = SDK_BLOCKED ? null : await loadSdk();
const WRITE = 'dacs.account.read dacs.agents.write dacs.purchases.write dacs.identities.write';
const key = (label) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

let h;
let chain;
before(async () => {
  if (SDK_BLOCKED) return;
  chain = await startSdkChainFixture();
  h = await startHarness({
    chain,
    env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback', DACS_IDENTITY_WRITES: 'simulated-fixture-only', DACS_EMBEDDED_WALLET_GITHUB_API_ORIGIN: chain.url },
  });
});
after(async () => {
  await h?.close();
});
afterEach(() => {
  if (!chain) return;
  for (const name of Object.keys(chain.faults)) chain.faults[name] = typeof chain.faults[name] === 'boolean' ? false : null;
});

async function post(origin, path, body) {
  const res = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json() };
}

// What portal.js builds from the server profile.
async function transportFrom(harness) {
  const profile = (await post(harness.origin, '/portal/api/embedded-wallet/profile')).body;
  return {
    profile: profile.writes,
    rpcUrl: profile.rpcUrl,
    network: profile.network,
    resolveGithubUser: async (username) => (await post(harness.origin, '/portal/api/wallet-rpc/github-user', { username })).body,
  };
}

// A real SDK session; approve answers from `decide` and records every request.
async function embedded(decide = () => true) {
  const asked = [];
  const session = createSdkWalletSession({
    DemosCtor: sdk.Demos,
    IdentitiesCtor: sdk.Identities,
    validateMnemonic: sdk.validateMnemonic,
    transactionTransport: await transportFrom(h),
    approve: async (request) => {
      asked.push(structuredClone(request));
      return decide(request, session);
    },
  });
  const account = await session.create();
  return { session, account, address: account.address, asked };
}

// Links the embedded wallet to the user's account through the portal link API,
// signing the server challenge with the real SDK session.
async function linkEmbedded(user, wallet) {
  const link = new URL((await tool(h, user, 'start_wallet_link')).linkUrl);
  const f = new URLSearchParams(link.hash.slice(1));
  const body = { accountId: f.get('a'), expires: Number(f.get('e')), nonce: f.get('n'), token: f.get('t') };
  const challenge = await post(h.origin, '/portal/api/link/challenge', { ...body, address: wallet.address });
  const signed = await wallet.session.request({ method: 'sign', params: [challenge.body.message] });
  const done = await post(h.origin, '/portal/api/link/complete', { ...body, challengeId: challenge.body.challengeId, signature: signed.data.signature });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.address, wallet.address);
}

async function buyerWithEmbedded(decide) {
  const user = await linkedUser(h, WRITE);
  const wallet = await embedded(decide);
  await linkEmbedded(user, wallet);
  return { user, wallet };
}

// prepare -> portal challenge -> real SDK sign -> approve: returns the exact
// payload the server fenced and saved for the wallet.
async function approvedPurchase({ user, wallet }, price = '2') {
  const seller = createEphemeralWallet();
  const listingId = key('ewt');
  seedSellerListing(h, seller, { listingId, price });
  const prepared = await tool(h, user, 'prepare_purchase', { listingId, version: 1, seller: seller.claim, idempotencyKey: key('buy'), walletAddress: wallet.address });
  assert.equal(prepared.status, 'awaiting_approval', JSON.stringify(prepared));
  const url = new URL(prepared.approvalUrl);
  const id = url.pathname.split('/').pop();
  const token = new URLSearchParams(url.hash.slice(1)).get('t');
  const challenge = await post(h.origin, `/portal/api/purchase/${id}/challenge`, { token, address: wallet.address });
  const signed = await wallet.session.request({ method: 'sign', params: [challenge.body.message] });
  const approved = await post(h.origin, `/portal/api/purchase/${id}/approve`, { token, challengeId: challenge.body.challengeId, signature: signed.data.signature });
  assert.equal(approved.body.status, 'payment_handoff', JSON.stringify(approved.body));
  return { id, token, seller, operationId: prepared.operationId, payload: approved.body.payload };
}

const executes = (from) => chain.calls.slice(from).filter((c) => c.startsWith('execute:'));

test('default profile is off: no relay, and an unconfigured session keeps writes not_configured', { skip: SDK_BLOCKED }, async () => {
  const plain = await startHarness();
  try {
    assert.deepEqual((await post(plain.origin, '/portal/api/embedded-wallet/profile')).body, { writes: 'off' });
    assert.equal((await fetch(`${plain.origin}/portal/api/wallet-rpc`)).status, 404);
    assert.equal((await post(plain.origin, '/portal/api/wallet-rpc', { method: 'nodeCall', params: [{ message: 'getAddressNonce', data: {} }] })).status, 404);
    assert.equal((await post(plain.origin, '/portal/api/wallet-rpc/github-user', { username: 'octo' })).status, 404);
  } finally {
    await plain.close();
  }
  const session = createSdkWalletSession({ DemosCtor: sdk.Demos, IdentitiesCtor: sdk.Identities, validateMnemonic: sdk.validateMnemonic, approve: async () => true });
  const account = await session.create();
  assert.equal(account.network, 'unconfigured');
  assert.equal(session.getWriteProfile(), null);
  const res = await session.request({ method: 'sendTransaction', params: [{}] });
  assert.equal(res.error.code, 'not_configured');
  session.lock();
});

test('config: simulated-loopback is refused without a loopback chain or with a non-loopback GitHub origin', () => {
  const base = { DACS_PUBLIC_ORIGIN: 'http://127.0.0.1:8787', DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(40), DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' };
  assert.throws(() => loadConfig(base), ConfigError);
  assert.throws(() => loadConfig({ ...base, DACS_CHAIN_RPC_URL: 'https://rpc.example.org' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, DACS_CHAIN_RPC_URL: 'http://127.0.0.1:9', DACS_EMBEDDED_WALLET_GITHUB_API_ORIGIN: 'https://api.github.com' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, DACS_EMBEDDED_WALLET_WRITES: 'live' }), ConfigError);
  const ok = loadConfig({ ...base, DACS_CHAIN_RPC_URL: 'http://127.0.0.1:9' });
  assert.deepEqual({ ...ok.embeddedWallet }, { writes: 'simulated-loopback', githubApiOrigin: null });
  assert.deepEqual({ ...loadConfig({ ...base, DACS_EMBEDDED_WALLET_WRITES: undefined }).embeddedWallet }, { writes: 'off', githubApiOrigin: null });
});

test('relay passes only the SDK calls the wallet makes', { skip: SDK_BLOCKED }, async () => {
  const before = chain.calls.length;
  assert.equal((await fetch(`${h.origin}/portal/api/wallet-rpc`)).status, 200);
  for (const body of [
    { method: 'nodeCall', params: [{ message: 'getMempool', data: {} }] },
    { method: 'gcr_routine', params: [{ method: 'getIdentities', params: ['0x00'] }] },
    { method: 'execute', params: [{ extra: 'somethingElse', data: {} }] },
    { method: 'execute', params: [{ extra: 'broadcastTx' }] },
    { method: 'nodeCall', params: [] },
  ]) {
    const res = await post(h.origin, '/portal/api/wallet-rpc', body);
    assert.equal(res.status, 403, JSON.stringify(body));
  }
  assert.deepEqual(chain.calls.slice(before), [], 'nothing refused reached the chain');
  const nonce = await post(h.origin, '/portal/api/wallet-rpc', { method: 'nodeCall', params: [{ message: 'getAddressNonce', data: { address: `0x${'1'.repeat(64)}` } }] });
  assert.deepEqual(nonce.body, { result: 200, response: 0 });
});

test('purchase: real SDK sign -> confirm -> one broadcast; the server settles only from its own readback', { skip: SDK_BLOCKED }, async () => {
  const buyer = await buyerWithEmbedded();
  const p = await approvedPurchase(buyer, '2');
  const nonceBefore = chain.nonceOf(buyer.wallet.address);
  assert.equal(p.payload.content.nonce, nonceBefore + 1, 'server fenced the next nonce');
  const mark = chain.calls.length;
  const asked = buyer.wallet.asked.length;

  const res = await buyer.wallet.session.request({ method: 'sendTransaction', params: [p.payload] });
  assert.equal(res.success, true, JSON.stringify(res.error));
  assert.deepEqual(Object.keys(res.data).sort(), ['evidenceMode', 'hash', 'nonce', 'status']);
  assert.equal(res.data.status, 'broadcast_accepted');
  assert.equal(res.data.nonce, p.payload.content.nonce);

  // Exactly one deliberate approval with the exact transfer.
  const approvals = buyer.wallet.asked.slice(asked);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].method, 'sendTransaction');
  assert.deepEqual(
    { from: approvals[0].content.from, to: approvals[0].content.to, amountOs: approvals[0].content.amountOs, amountDem: approvals[0].content.amountDem, nonce: approvals[0].content.nonce },
    { from: buyer.wallet.address, to: p.payload.content.to, amountOs: '2000000000', amountDem: '2', nonce: p.payload.content.nonce },
  );
  assert.match(approvals[0].content.evidence, /SIMULATED/);

  // The SDK's wire through the relay: reads, then confirm, then one broadcast;
  // the fixture verified hash, signature and the timestamped auth header.
  assert.deepEqual(executes(mark), ['execute:confirmTx', 'execute:broadcastTx']);
  assert.ok(chain.calls.slice(mark).includes('nodeCall:getNetworkInfo'));
  assert.ok(chain.auth.slice(-2).every((a) => a.verified && a.identity === `ed25519:${buyer.wallet.address}`));
  assert.deepEqual(chain.broadcasts.at(-1), { hash: res.data.hash, applied: true });
  const onChain = chain.txs.get(res.data.hash).content;
  assert.equal(onChain.nonce, p.payload.content.nonce);
  assert.equal(onChain.timestamp, p.payload.content.timestamp, 'the exact server payload was signed');
  assert.equal(onChain.amount, '2000000000');
  assert.equal(chain.nonceOf(buyer.wallet.address), nonceBefore + 1);

  // Independent server readback decides settlement.
  const pending = await tool(h, buyer.user, 'get_purchase_status', { operationId: p.operationId });
  assert.equal(pending.status, 'payment_handoff', 'a wallet result alone is not settlement');
  const reported = await post(h.origin, `/portal/api/purchase/${p.id}/report`, { token: p.token, txHash: res.data.hash });
  assert.equal(reported.body.status, 'settled_verified', JSON.stringify(reported.body.verification));
  assert.equal(reported.body.verification.outcome, 'verified');
  assert.equal(reported.body.evidence.receipt.txHash, res.data.hash);
  assert.equal(reported.body.evidence.receipt.chainMode, 'simulated-fixture');
  assert.equal((await tool(h, buyer.user, 'get_purchase_status', { operationId: p.operationId })).status, 'settled_verified');
  buyer.wallet.session.lock();
});

test('purchase: rejecting or locking during approval signs and sends nothing', { skip: SDK_BLOCKED }, async () => {
  let mode = 'reject';
  const buyer = await buyerWithEmbedded((request, session) => {
    if (request.method !== 'sendTransaction') return true;
    if (mode === 'lock') session.lock();
    return mode === 'lock';
  });
  const p = await approvedPurchase(buyer);
  const mark = chain.calls.length;
  const broadcasts = chain.broadcasts.length;
  const rejected = await buyer.wallet.session.request({ method: 'sendTransaction', params: [p.payload] });
  assert.deepEqual(rejected, { success: false, data: null, error: { code: 'user_rejected', message: 'the request was not approved; nothing was signed' } });
  mode = 'lock';
  const locked = await buyer.wallet.session.request({ method: 'sendTransaction', params: [p.payload] });
  assert.equal(locked.error.code, 'locked');
  assert.equal(buyer.wallet.session.isLocked(), true);
  assert.deepEqual(executes(mark), [], 'no confirm or broadcast');
  assert.equal(chain.broadcasts.length, broadcasts);
  assert.equal((await buyer.wallet.session.request({ method: 'sendTransaction', params: [p.payload] })).error.code, 'locked');
  // Nothing was consumed: the server still sees the open handoff.
  const verify = await tool(h, buyer.user, 'verify_deal', { operationId: p.operationId });
  assert.equal(verify.status, 'payment_handoff');
});

test('purchase: payload for another wallet and malformed payloads are refused before approval', { skip: SDK_BLOCKED }, async () => {
  const buyer = await buyerWithEmbedded();
  const p = await approvedPurchase(buyer);
  const asked = buyer.wallet.asked.length;
  const other = structuredClone(p.payload);
  other.content.from = `0x${'2'.repeat(64)}`;
  assert.equal((await buyer.wallet.session.request({ method: 'sendTransaction', params: [other] })).error.code, 'wrong_wallet');
  const storage = structuredClone(p.payload);
  storage.content.type = 'storageProgram';
  assert.equal((await buyer.wallet.session.request({ method: 'sendTransaction', params: [storage] })).error.code, 'invalid_params');
  const mismatched = structuredClone(p.payload);
  mismatched.content.data[1].args[1] = '1';
  assert.equal((await buyer.wallet.session.request({ method: 'sendTransaction', params: [mismatched] })).error.code, 'invalid_params');
  assert.equal((await buyer.wallet.session.request({ method: 'sendTransaction', params: [] })).error.code, 'invalid_params');
  assert.equal(buyer.wallet.asked.length, asked, 'no approval was requested');
  assert.equal((await buyer.wallet.session.request({ method: 'signTransaction', params: [p.payload] })).error.code, 'unsupported');
  buyer.wallet.session.lock();
});

test('purchase: a node validation refusal is confirm_rejected and nothing is broadcast', { skip: SDK_BLOCKED }, async () => {
  const buyer = await buyerWithEmbedded();
  const p = await approvedPurchase(buyer);
  chain.faults.confirmInvalid = true;
  const mark = chain.calls.length;
  const res = await buyer.wallet.session.request({ method: 'sendTransaction', params: [p.payload] });
  assert.equal(res.error.code, 'confirm_rejected');
  assert.equal(res.data, null);
  assert.deepEqual(executes(mark), ['execute:confirmTx']);
  buyer.wallet.session.lock();
});

test('purchase: a refused broadcast is broadcast_rejected; a lost answer is outcome_unknown, never retried, and readback still settles it', { skip: SDK_BLOCKED }, async () => {
  const buyer = await buyerWithEmbedded();
  const p = await approvedPurchase(buyer);
  chain.faults.broadcastRefuse = true;
  let mark = chain.calls.length;
  const refused = await buyer.wallet.session.request({ method: 'sendTransaction', params: [p.payload] });
  assert.equal(refused.error.code, 'broadcast_rejected');
  assert.match(refused.data.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(executes(mark), ['execute:confirmTx', 'execute:broadcastTx']);
  chain.faults.broadcastRefuse = false;

  // The node applies the transfer but the answer is lost.
  chain.faults.broadcastDropAfterApply = true;
  mark = chain.calls.length;
  const broadcasts = chain.broadcasts.length;
  const unknown = await buyer.wallet.session.request({ method: 'sendTransaction', params: [p.payload] });
  assert.equal(unknown.success, false);
  assert.equal(unknown.error.code, 'outcome_unknown');
  assert.equal(unknown.data.nonce, p.payload.content.nonce);
  assert.deepEqual(executes(mark), ['execute:confirmTx', 'execute:broadcastTx'], 'exactly one broadcast; no retry by SDK, relay or adapter');
  assert.equal(chain.broadcasts.length, broadcasts + 1);
  assert.equal(chain.broadcasts.at(-1).applied, true);

  // The portal reports the wallet error (never a retry); the server's own
  // readback with the hash as a pointer is what settles the purchase.
  await post(h.origin, `/portal/api/purchase/${p.id}/report`, { token: p.token, walletError: unknown.error.message });
  assert.equal((await tool(h, buyer.user, 'get_purchase_status', { operationId: p.operationId })).status, 'payment_handoff');
  const verified = await tool(h, buyer.user, 'verify_deal', { operationId: p.operationId, txHash: unknown.data.hash });
  assert.equal(verified.status, 'settled_verified', JSON.stringify(verified));
  buyer.wallet.session.lock();
});

// Drives the existing identity portal API exactly as portal.js does.
function identityPortal(start) {
  const url = new URL(start.portalUrl);
  const id = url.pathname.split('/').pop();
  const token = new URLSearchParams(url.hash.slice(1)).get('t');
  return async (step, body = {}) => (await post(h.origin, `/portal/api/identity/${id}/${step}`, { token, ...body })).body;
}

async function identityAction(user, wallet, { action, kind, username, proofUrl }) {
  const start = await tool(h, user, 'start_identity_action', { idempotencyKey: key('id'), action, kind, walletAddress: wallet.address, ...(username ? { username } : {}) });
  assert.equal(start.status, 'prepared', JSON.stringify(start));
  const call = identityPortal(start);
  assert.equal((await call('view')).status, 'awaiting_wallet');
  const connected = await call('connected', { address: wallet.address });
  if (action === 'add') {
    assert.equal(connected.status, 'awaiting_public_proof');
    const proof = await wallet.session.request({ method: 'getWeb2IdentityProofPayload', params: [] });
    assert.match(proof.data, /^demos:dw2p:ed25519:0x[0-9a-f]{128}$/);
    assert.equal((await call('proof', { proofUrl })).status, 'review');
  } else {
    assert.equal(connected.status, 'review');
  }
  const asked = await call('request');
  const outcome = await wallet.session.request(asked.walletRequest);
  const reported = await call('report', {
    outcome: outcome.success ? { success: true } : { success: false, code: outcome.error.code, message: outcome.error.message },
  });
  return { asked, outcome, reported };
}

test('identity: Twitter add, GitHub add and remove with real SDK identity transactions, observed by server readback', { skip: SDK_BLOCKED }, async () => {
  const user = await linkedUser(h, WRITE);
  const wallet = await embedded();
  await linkEmbedded(user, wallet);
  const tweet = 'https://x.com/Dacs_Tester/status/1234567890';
  chain.seedTweet(tweet, { username: 'Dacs_Tester', userId: '4242' });
  chain.seedGithubUser('octo-dacs', 777);
  const gist = 'https://gist.github.com/octo-dacs/0123456789abcdef';

  let mark = chain.calls.length;
  const tw = await identityAction(user, wallet, { action: 'add', kind: 'twitter', proofUrl: tweet });
  assert.deepEqual(tw.asked.walletRequest, { method: 'addTwitterIdentity', params: [tweet] });
  assert.equal(tw.outcome.success, true, JSON.stringify(tw.outcome.error));
  assert.equal(tw.reported.status, 'association_observed');
  assert.equal(tw.reported.walletOutcome.classification, 'wallet_reported_success');
  assert.ok(chain.calls.slice(mark).includes('nodeCall:getTweet'), 'the SDK read the tweet through the relay');
  assert.deepEqual(executes(mark), ['execute:confirmTx', 'execute:broadcastTx']);
  const approval = wallet.asked.at(-1);
  assert.equal(approval.method, 'addTwitterIdentity');
  assert.deepEqual({ ...approval.content, network: undefined, evidence: undefined, sending: undefined },
    { action: 'add web2 identity', wallet: wallet.address, context: 'twitter', username: 'Dacs_Tester', userId: '4242', proofUrl: tweet, nonce: chain.nonceOf(wallet.address), network: undefined, evidence: undefined, sending: undefined });
  const twEntry = chain.web2Of(wallet.address).twitter;
  assert.deepEqual(twEntry.map((e) => [e.username, e.userId, e.proof]), [['Dacs_Tester', '4242', tweet]]);

  mark = chain.calls.length;
  const gh = await identityAction(user, wallet, { action: 'add', kind: 'github', proofUrl: gist });
  assert.equal(gh.outcome.success, true, JSON.stringify(gh.outcome.error));
  assert.equal(gh.reported.status, 'association_observed');
  assert.deepEqual(chain.web2Of(wallet.address).github.map((e) => [e.username, e.userId]), [['octo-dacs', 777]]);
  assert.ok(chain.calls.slice(mark).includes('GET /\x75sers/octo-dacs'));

  const rm = await identityAction(user, wallet, { action: 'remove', kind: 'twitter', username: 'dacs_tester' });
  assert.deepEqual(rm.asked.walletRequest, { method: 'removeWeb2Identity', params: [{ context: 'twitter', username: 'Dacs_Tester' }] });
  assert.equal(rm.outcome.success, true, JSON.stringify(rm.outcome.error));
  assert.equal(rm.reported.status, 'removal_observed');
  assert.deepEqual(chain.web2Of(wallet.address).twitter, []);
  const ids = await tool(h, user, 'get_identities', { walletAddress: wallet.address });
  assert.ok(JSON.stringify(ids).includes('octo-dacs'));
  wallet.session.lock();
});

test('identity: a mismatched proof owner and a declined approval sign nothing; the decline is rejected_before_send', { skip: SDK_BLOCKED }, async () => {
  const user = await linkedUser(h, WRITE);
  const wallet = await embedded();
  await linkEmbedded(user, wallet);
  const tweet = 'https://x.com/someone_else/status/42';
  chain.seedTweet(tweet, { username: 'someone_else', userId: '1' });
  chain.faults.tweetMismatch = 'impostor';
  const mark = chain.calls.length;
  const mismatch = await identityAction(user, wallet, { action: 'add', kind: 'twitter', proofUrl: tweet });
  assert.equal(mismatch.outcome.error.code, 'identity_mismatch');
  assert.equal(mismatch.reported.walletOutcome.classification, 'unknown', 'only readback can settle a non-rejection');
  // An unknown outcome keeps this wallet's identity action in flight (server rule).
  assert.equal((await tool(h, user, 'start_identity_action', { idempotencyKey: key('id'), action: 'add', kind: 'twitter', walletAddress: wallet.address })).error, 'identity_operation_in_progress');
  chain.faults.tweetMismatch = null;
  wallet.session.lock();

  const user2 = await linkedUser(h, WRITE);
  const wallet2 = await embedded((request) => ['sign', 'getWeb2IdentityProofPayload'].includes(request.method));
  await linkEmbedded(user2, wallet2);
  chain.seedTweet('https://twitter.com/someone_else/status/43', { username: 'someone_else', userId: '1' });
  const declined = await identityAction(user2, wallet2, { action: 'add', kind: 'twitter', proofUrl: 'https://twitter.com/someone_else/status/43' });
  assert.equal(declined.outcome.error.code, 'user_rejected');
  assert.equal(declined.reported.status, 'rejected_before_send');
  assert.equal(wallet2.asked.at(-1).method, 'addTwitterIdentity');
  assert.deepEqual(executes(mark), [], 'nothing was validated or broadcast');
  wallet2.session.lock();
});

test('provider output never carries the recovery phrase across write paths', { skip: SDK_BLOCKED }, async () => {
  const wallet = await embedded(() => false);
  const phrase = wallet.session.exportMnemonicForUser();
  const outputs = [
    wallet.session.getPublicAccount(),
    wallet.session.getWriteProfile(),
    await wallet.session.request({ method: 'sendTransaction', params: [{ content: {} }] }),
    await wallet.session.request({ method: 'addTwitterIdentity', params: ['https://x.com/a/status/1'] }),
    await wallet.session.request({ method: 'removeWeb2Identity', params: [{ context: 'github', username: 'a' }] }),
  ];
  const text = JSON.stringify(outputs);
  assert.ok(!text.includes(phrase), 'no phrase in output');
  assert.ok(!text.includes(phrase.split(' ').slice(0, 3).join(' ')), 'no phrase fragment in output');
  assert.equal(outputs[0].evidenceMode, 'simulated-fixture');
  assert.ok(!h.logs.some((line) => JSON.stringify(line).includes(phrase.split(' ').slice(0, 3).join(' '))), 'no phrase fragment in server logs');
  wallet.session.lock();
});
