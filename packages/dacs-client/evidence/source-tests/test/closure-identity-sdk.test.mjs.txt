// Closure (identity recovery) with the REAL pinned embedded wallet: the actual
// public/portal/embedded-wallet/sdk-provider.mjs session over the installed
// upstream @kynesyslabs/demosdk 4.0.16 (wallet-build/), through the plugin's
// same-origin relay to a SIMULATED loopback node that records every call.
// It shows which wallet answers happen before any broadcast (the node log has
// no broadcastTx), that the server then closes the action instead of
// stranding the wallet, and that a corrected fresh action for the same wallet
// succeeds without a restart. Ambiguous broadcast answers stay unknown and
// are never retried. The report body is built exactly as portal.js
// walletOutcome() builds it for the embedded wallet.
// Functional offline tests: not a security review, not browser or live proof.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

import { startHarness } from './helpers/harness.mjs';
import { tool, linkedUser } from './helpers/flows.mjs';
import { createSdkWalletSession } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { startSdkChainFixture } from './helpers/embedded-wallet-transaction-chain.mjs';

const buildDir = new URL('../wallet-build/', import.meta.url);
const sdkDir = new URL('node_modules/@kynesyslabs/demosdk/', buildDir);
const SDK_BLOCKED = existsSync(new URL('package.json', sdkDir)) ? false : 'BLOCKED: wallet-build dependencies are not installed';

// Same resolution shim as embedded-wallet-transaction.test.mjs: only importers
// inside the installed SDK get dir/ -> dir/index.js and ./x -> ./x.js.
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
const WRITE = 'dacs.account.read dacs.purchases.write dacs.identities.write';
const key = (label) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

let h;
let chain;
before(async () => {
  if (SDK_BLOCKED) return;
  chain = await startSdkChainFixture();
  h = await startHarness({
    chain,
    // Each linked account and each relayed SDK call counts against the
    // documented per-minute limit; it is raised for this harness only.
    env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback', DACS_IDENTITY_WRITES: 'simulated-fixture-only', DACS_EMBEDDED_WALLET_GITHUB_API_ORIGIN: chain.url, DACS_RATE_LIMIT_PER_MINUTE: '100000' },
  });
});
after(async () => {
  await h?.close();
});
afterEach(() => {
  if (!chain) return;
  for (const name of Object.keys(chain.faults)) chain.faults[name] = typeof chain.faults[name] === 'boolean' ? false : null;
});

async function post(path, body) {
  const res = await fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json() };
}

// What portal.js embeddedTransport() builds from the server profile.
async function transport() {
  const profile = (await post('/portal/api/embedded-wallet/profile')).body;
  return { profile: profile.writes, rpcUrl: profile.rpcUrl, network: profile.network, resolveGithubUser: async (username) => (await post('/portal/api/wallet-rpc/github-user', { username })).body };
}

// A real SDK session linked to a fresh account; approve answers from `decide`.
async function walletUser(decide = () => true) {
  const user = await linkedUser(h, WRITE);
  const asked = [];
  const session = createSdkWalletSession({
    DemosCtor: sdk.Demos, IdentitiesCtor: sdk.Identities, validateMnemonic: sdk.validateMnemonic, transactionTransport: await transport(),
    approve: async (request) => {
      asked.push(request.method);
      return decide(request);
    },
  });
  const { address } = await session.create();
  const link = new URL((await tool(h, user, 'start_wallet_link')).linkUrl);
  const f = new URLSearchParams(link.hash.slice(1));
  const body = { accountId: f.get('a'), expires: Number(f.get('e')), nonce: f.get('n'), token: f.get('t') };
  const challenge = await post('/portal/api/link/challenge', { ...body, address });
  const signed = await session.request({ method: 'sign', params: [challenge.body.message] });
  assert.equal((await post('/portal/api/link/complete', { ...body, challengeId: challenge.body.challengeId, signature: signed.data.signature })).status, 200);
  return { user, session, address, asked };
}

// public/portal/portal.js walletOutcome() for the embedded wallet.
function portalOutcome(res) {
  if (res && typeof res === 'object' && res.success === true) return { success: true, wallet: 'embedded' };
  if (res && typeof res === 'object' && res.success === false) return { success: false, code: res.error?.code ?? null, message: res.error?.message ?? null, wallet: 'embedded' };
  return { success: false, code: null, message: 'unrecognized wallet response', wallet: 'embedded' };
}

const executes = (from) => chain.calls.slice(from).filter((c) => c.startsWith('execute:'));

// One identity action through the portal API, the wallet asked exactly once.
async function identityAction(w, { action = 'add', kind, proofUrl, username }) {
  const start = await tool(h, w.user, 'start_identity_action', { idempotencyKey: key('cis'), action, kind, walletAddress: w.address, ...(username ? { username } : {}) });
  assert.equal(start.status, 'prepared', JSON.stringify(start));
  const url = new URL(start.portalUrl);
  const id = url.pathname.split('/').pop();
  const token = new URLSearchParams(url.hash.slice(1)).get('t');
  const call = async (step, extra = {}) => (await post(`/portal/api/identity/${id}/${step}`, { token, ...extra })).body;
  await call('view');
  await call('connected', { address: w.address });
  if (action === 'add') assert.equal((await call('proof', { proofUrl })).status, 'review');
  const askedReq = await call('request');
  assert.equal(askedReq.status, 'wallet_requested');
  const mark = chain.calls.length;
  const broadcastsBefore = chain.broadcasts.length;
  const res = await w.session.request(askedReq.walletRequest);
  const node = { executes: executes(mark), broadcasts: chain.broadcasts.length - broadcastsBefore };
  const reported = await call('report', { outcome: portalOutcome(res) });
  return { start, res, node, reported, call };
}

const nextStart = (w, kind = 'github') => tool(h, w.user, 'start_identity_action', { idempotencyKey: key('next'), action: 'add', kind, walletAddress: w.address });

test('accepting control [sdk-real]: GitHub add then remove complete from readback, reported as the repaired portal reports', { skip: SDK_BLOCKED }, async () => {
  const w = await walletUser();
  chain.seedGithubUser('closure-sdk', 4711);
  const gist = 'https://gist.github.com/closure-sdk/0123456789abcdef';
  const add = await identityAction(w, { kind: 'github', proofUrl: gist });
  assert.equal(add.res.success, true, JSON.stringify(add.res.error));
  assert.deepEqual(add.node, { executes: ['execute:confirmTx', 'execute:broadcastTx'], broadcasts: 1 });
  assert.equal(add.reported.status, 'association_observed');
  assert.equal(add.reported.walletOutcome.wallet, 'embedded');
  const rm = await identityAction(w, { action: 'remove', kind: 'github', username: 'closure-sdk' });
  assert.equal(rm.res.success, true, JSON.stringify(rm.res.error));
  assert.equal(rm.reported.status, 'removal_observed');
  assert.deepEqual(chain.web2Of(w.address).github, []);
  w.session.lock();
});

test('missing prerequisite [sdk-real]: an unpublished Twitter post fails before approval and before any broadcast; the action closes and the corrected fresh action succeeds', { skip: SDK_BLOCKED }, async () => {
  const w = await walletUser();
  const missing = 'https://x.com/closure_sdk_tw/status/1001';
  const failed = await identityAction(w, { kind: 'twitter', proofUrl: missing });
  assert.equal(failed.res.error.code, 'upstream_unavailable');
  assert.match(failed.res.error.message, /nothing was signed/);
  assert.deepEqual(failed.node, { executes: [], broadcasts: 0 }, 'nothing validated or broadcast');
  assert.ok(!w.asked.includes('addTwitterIdentity'), 'the approval was never even asked');
  assert.equal(failed.reported.status, 'failed_before_send');
  assert.equal(failed.reported.walletOutcome.classification, 'failed_before_send');
  assert.equal((await failed.call('request')).error, 'invalid_state', 'never re-requested');

  // The person publishes the post; a fresh action for the same wallet works.
  chain.seedTweet(missing, { username: 'closure_sdk_tw', userId: '1001' });
  const fixed = await identityAction(w, { kind: 'twitter', proofUrl: missing });
  assert.equal(fixed.res.success, true, JSON.stringify(fixed.res.error));
  assert.equal(fixed.reported.status, 'association_observed');
  assert.deepEqual(chain.web2Of(w.address).twitter.map((e) => e.username), ['closure_sdk_tw']);
  w.session.lock();
});

test('pre-send wallet failures [sdk-real]: unknown GitHub user, mismatched proof owner and a node validation refusal never broadcast and close the action; the wallet stays usable', { skip: SDK_BLOCKED }, async () => {
  const w = await walletUser();
  const ghost = await identityAction(w, { kind: 'github', proofUrl: 'https://gist.github.com/no-such-closure-user/0123456789abcdef' });
  assert.equal(ghost.res.error.code, 'upstream_unavailable');
  assert.deepEqual(ghost.node, { executes: [], broadcasts: 0 });
  assert.equal(ghost.reported.status, 'failed_before_send');
  assert.ok(chain.calls.includes('GET /\x75sers/no-such-closure-user'), 'the GitHub stand-in was asked and answered not found');

  chain.seedTweet('https://x.com/someone_closure/status/7', { username: 'someone_closure', userId: '7' });
  chain.faults.tweetMismatch = 'impostor_closure';
  const mismatch = await identityAction(w, { kind: 'twitter', proofUrl: 'https://x.com/someone_closure/status/7' });
  assert.equal(mismatch.res.error.code, 'identity_mismatch');
  assert.deepEqual(mismatch.node, { executes: [], broadcasts: 0 });
  assert.equal(mismatch.reported.status, 'failed_before_send');
  chain.faults.tweetMismatch = null;

  chain.seedGithubUser('closure-confirm', 99);
  chain.faults.confirmInvalid = true;
  const nonceBefore = chain.nonceOf(w.address);
  const refused = await identityAction(w, { kind: 'github', proofUrl: 'https://gist.github.com/closure-confirm/0123456789abcdef' });
  assert.equal(refused.res.error.code, 'confirm_rejected');
  assert.deepEqual(refused.node, { executes: ['execute:confirmTx'], broadcasts: 0 }, 'validated by the node, never broadcast');
  assert.ok(w.asked.includes('addGithubIdentity'), 'this one failed after the approval');
  assert.equal(refused.reported.status, 'failed_before_send');
  assert.equal(chain.nonceOf(w.address), nonceBefore, 'nothing executed');
  chain.faults.confirmInvalid = false;

  const ok = await identityAction(w, { kind: 'github', proofUrl: 'https://gist.github.com/closure-confirm/0123456789abcdef' });
  assert.equal(ok.res.success, true, JSON.stringify(ok.res.error));
  assert.equal(ok.reported.status, 'association_observed');
  w.session.lock();
});

test('a declined approval [sdk-real] is still rejected_before_send', { skip: SDK_BLOCKED }, async () => {
  const w = await walletUser((request) => request.method !== 'addTwitterIdentity');
  chain.seedTweet('https://x.com/decline_closure/status/8', { username: 'decline_closure', userId: '8' });
  const declined = await identityAction(w, { kind: 'twitter', proofUrl: 'https://x.com/decline_closure/status/8' });
  assert.equal(declined.res.error.code, 'user_rejected');
  assert.deepEqual(declined.node, { executes: [], broadcasts: 0 });
  assert.equal(declined.reported.status, 'rejected_before_send');
  assert.equal((await nextStart(w)).status, 'prepared');
  w.session.lock();
});

test('ambiguous broadcast answers [sdk-real] stay unknown, keep the wallet blocked, and are never retried; a write that did land is settled by readback', { skip: SDK_BLOCKED }, async () => {
  const cases = [
    ['lost connection before the node applied it', 'broadcastDropBeforeApply', 'outcome_unknown', 'readback_pending'],
    ['node refused the broadcast', 'broadcastRefuse', 'broadcast_rejected', 'readback_pending'],
    ['node applied it, answer lost', 'broadcastDropAfterApply', 'outcome_unknown', 'association_observed'],
  ];
  for (const [label, fault, code, status] of cases) {
    const w = await walletUser();
    const handle = `amb-${fault.toLowerCase()}`.slice(0, 39);
    chain.seedGithubUser(handle, 5);
    chain.faults[fault] = true;
    const r = await identityAction(w, { kind: 'github', proofUrl: `https://gist.github.com/${handle}/0123456789abcdef` });
    chain.faults[fault] = false;
    assert.equal(r.res.error.code, code, label);
    assert.deepEqual(r.node, { executes: ['execute:confirmTx', 'execute:broadcastTx'], broadcasts: 1 }, `${label}: exactly one broadcast`);
    assert.equal(r.reported.walletOutcome.classification, 'unknown', label);
    assert.equal(r.reported.status, status, label);
    // Re-reading never re-broadcasts.
    const broadcasts = chain.broadcasts.length;
    await r.call('view');
    assert.equal(chain.broadcasts.length, broadcasts, `${label}: no retry`);
    assert.equal((await r.call('request')).error, 'invalid_state', `${label}: never re-requested`);
    const next = await nextStart(w, 'twitter');
    if (status === 'association_observed') {
      assert.equal(next.status, 'prepared', `${label}: settled by readback, wallet free`);
    } else {
      assert.equal(next.error, 'identity_operation_in_progress', label);
      assert.equal(next.details.cancellable, false, label);
      assert.equal((await r.call('cancel')).error, 'invalid_state', label);
    }
    w.session.lock();
  }
});
