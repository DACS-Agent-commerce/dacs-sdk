// Overnight-core: embedded-wallet seller publication over the EXISTING seller
// state machine (src/agents.mjs), with the REAL upstream @kynesyslabs/demosdk
// 4.0.16 (wallet-build/) signing the server's exact storage-program create
// through the plugin's same-origin relay to a SIMULATED loopback node
// (test/helpers/overnight-core-fixtures.mjs) that checks hash, signature,
// nonce and the storage address independently. Publication, discoverability
// and settlement are decided only by the plugin server's own readback.
// Also: the public stage model, the portal re-check route and the HELD
// testnet profile. Ordinary offline functional tests: not a security review,
// not browser, installed-wallet, live-network or v0.1 acceptance proof. Keys
// are fresh and in memory; no secret is printed.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

import { loadConfig, ConfigError } from '../src/config.mjs';
import { publicationStages, PUBLICATION_STAGES } from '../src/agents.mjs';
import { createWalletRpcRouter } from '../src/portal/wallet-rpc.mjs';
import { buildNativeTransferPayload } from '../src/dacs/wallet-transactions.mjs';
import { startHarness } from './helpers/harness.mjs';
import { tool, linkedUser, tokenFrom } from './helpers/flows.mjs';
import { sellerValue } from './helpers/model-report.mjs';
import { createSdkWalletSession } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { startOvernightChain, startOvernightDirectory } from './helpers/overnight-core-fixtures.mjs';

const buildDir = new URL('../wallet-build/', import.meta.url);
const sdkDir = new URL('node_modules/@kynesyslabs/demosdk/', buildDir);
const SDK_BLOCKED = existsSync(new URL('package.json', sdkDir)) ? false : 'BLOCKED: wallet-build dependencies are not installed';
// The prepared dependencies may be a symlinked node_modules; importers inside
// the SDK then carry the real path.
const sdkPrefixes = SDK_BLOCKED ? [] : [sdkDir.href, `${pathToFileURL(realpathSync(fileURLToPath(sdkDir))).href}/`];

// Same scoped resolution shim as embedded-wallet-transaction.test.mjs: only
// importers inside the installed SDK get dir/ -> dir/index.js and ./x -> ./x.js.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!sdkPrefixes.some((prefix) => context.parentURL?.startsWith(prefix))) throw error;
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
  const { StorageProgram } = await import(new URL('build/storage/StorageProgram.js', sdkDir).href);
  const { validateMnemonic: bip39Validate } = await import(pathToFileURL(require.resolve('@scure/bip39')).href);
  const { wordList } = await import(new URL('build/encryption/PQC/falconts/wordlist.js', sdkDir).href);
  return { Demos, Identities, StorageProgram, validateMnemonic: (m) => typeof m === 'string' && bip39Validate(m, wordList) };
}

const sdk = SDK_BLOCKED ? null : await loadSdk();
const WRITE = 'dacs.account.read dacs.agents.write dacs.purchases.write';
const rand = () => Math.random().toString(36).slice(2, 10);
const key = (label) => `${label}-${rand()}`;
const BASE_ENV = { DACS_PUBLIC_ORIGIN: 'http://127.0.0.1:8787', DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(40) };

let h;
let chain;
let directory;
before(async () => {
  if (SDK_BLOCKED) return;
  chain = await startOvernightChain();
  directory = await startOvernightDirectory({ chain });
  h = await startHarness({ chain, directory, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
});
after(async () => {
  await h?.close();
});
afterEach(() => chain?.resetFaults());

async function post(origin, path, body) {
  const res = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json() };
}

// What portal.js builds from the server profile.
async function transportFrom(harness) {
  const profile = (await post(harness.origin, '/portal/api/embedded-wallet/profile')).body;
  return { profile: profile.writes, rpcUrl: profile.rpcUrl, network: profile.network };
}

async function embedded(decide = () => true, { DemosCtor } = {}) {
  const asked = [];
  const session = createSdkWalletSession({
    DemosCtor: DemosCtor ?? sdk.Demos,
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

// Links the embedded wallet through the portal link API (real SDK signature).
async function linkEmbedded(user, wallet) {
  const link = new URL((await tool(h, user, 'start_wallet_link')).linkUrl);
  const f = new URLSearchParams(link.hash.slice(1));
  const body = { accountId: f.get('a'), expires: Number(f.get('e')), nonce: f.get('n'), token: f.get('t') };
  const challenge = await post(h.origin, '/portal/api/link/challenge', { ...body, address: wallet.address });
  const signed = await wallet.session.request({ method: 'sign', params: [challenge.body.message] });
  const done = await post(h.origin, '/portal/api/link/complete', { ...body, challengeId: challenge.body.challengeId, signature: signed.data.signature });
  assert.equal(done.status, 200, JSON.stringify(done.body));
}

async function sellerWithEmbedded(decide, options) {
  const user = await linkedUser(h, WRITE);
  const wallet = await embedded(decide, options);
  await linkEmbedded(user, wallet);
  return { user, wallet };
}

async function registerSeller({ user, wallet }, overrides = {}) {
  const input = {
    idempotencyKey: key('reg'), listingId: key('oc-svc'), displayName: 'Overnight Core Seller', endpointUrl: 'https://seller.example/agent',
    title: 'Overnight core service', description: 'SIMULATED seller service published from the embedded wallet.', category: 'services.test',
    tags: ['overnight'], priceDem: '2', validDays: 7, walletAddress: wallet.address, ...overrides,
  };
  const r = await tool(h, user, 'register_agent', input);
  assert.equal(r.status, 'awaiting_identity_signature', JSON.stringify(r));
  return { ...r, input, token: tokenFrom(r.portalUrl) };
}

const pub = async (r, step, body = {}) => post(h.origin, `/portal/api/publish/${r.operationId}/${step}`, { token: r.token, ...body });
const states = (view) => Object.fromEntries(view.stages.map((s) => [s.id, s.state]));
const stage = (view, id) => view.stages.find((s) => s.id === id);
const executes = (from) => chain.calls.slice(from).filter((c) => c.startsWith('execute:'));
const digit = () => 1 + Math.floor(Math.random() * 9);
// A canonical DEM decimal with no trailing zero, different on every run.
const freshPrice = () => `${1 + digit()}.${digit()}${digit()}`;

// Identity + listing signatures with the real SDK session, exactly as portal.js does.
async function signThrough(r, wallet) {
  const view = (await pub(r, 'view')).body;
  assert.equal(view.signRequest.step, 'identity');
  const idSig = await wallet.session.request({ method: 'sign', params: [view.signRequest.message] });
  assert.equal(idSig.success, true, JSON.stringify(idSig.error));
  const identity = (await pub(r, 'identity', { address: wallet.address, signature: idSig.data.signature })).body;
  assert.equal(identity.status, 'awaiting_listing_signature', JSON.stringify(identity));
  const listSig = await wallet.session.request({ method: 'sign', params: [identity.signRequest.message] });
  const listed = (await pub(r, 'listing', { signature: listSig.data.signature })).body;
  assert.equal(listed.status, 'publication_handoff', JSON.stringify(listed));
  return { view, identity, listed, payload: listed.payload };
}

// ---------------- stage model (pure) ----------------

test('publicationStages: every persisted status maps to the documented, separate broadcast / readback / directory stages', () => {
  // Independent expectation: the INTERFACE.md §2 table, written out here.
  const P = 'pending';
  const A = 'action_required';
  const V = 'verified';
  const expected = {
    awaiting_identity_signature: [A, P, P, P, P, P],
    awaiting_listing_signature: [V, A, P, P, P, P],
    listing_signed: [V, V, A, P, P, P],
    publication_handoff: [V, V, A, P, P, P],
    broadcast_reported: [V, V, 'reported', 'waiting', P, P],
    publication_uncertain: [V, V, 'unknown', 'waiting', P, P],
    publication_mismatch: [V, V, 'reported', 'failed', P, P],
    chain_verified: [V, V, V, V, A, P],
    directory_submitted: [V, V, V, V, 'reported', 'waiting'],
    directory_visible: [V, V, V, V, V, V],
  };
  const ids = ['identity_signature', 'listing_signature', 'storage_write', 'chain_readback', 'directory_submission', 'directory_visibility'];
  assert.deepEqual(PUBLICATION_STAGES.map(([id]) => id), ids);
  for (const [status, row] of Object.entries(expected)) {
    const out = publicationStages({ status, state: {} });
    assert.deepEqual(out.map((s) => s.id), ids, status);
    assert.deepEqual(out.map((s) => s.state), row, status);
  }
  // Broadcast never implies readback; submission never implies visibility.
  for (const status of Object.keys(expected)) {
    const s = Object.fromEntries(publicationStages({ status, state: {} }).map((x) => [x.id, x.state]));
    if (s.chain_readback === V) assert.equal(s.storage_write, V, status);
    if (s.storage_write !== V) assert.notEqual(s.chain_readback, V, status);
    if (s.directory_visibility === V) assert.equal(s.directory_submission, V, status);
  }
  // Cancelled reports only what was verified before the cancel.
  const cancelled = (state) => publicationStages({ status: 'cancelled', state }).map((x) => x.state);
  assert.deepEqual(cancelled({}), ['cancelled', P, 'cancelled', P, P, P]);
  assert.deepEqual(cancelled({ identityBundle: {} }), [V, 'cancelled', 'cancelled', P, P, P]);
  assert.deepEqual(cancelled({ identityBundle: {}, signedListing: {} }), [V, V, 'cancelled', P, P, P]);
  assert.deepEqual(publicationStages({ status: 'something_new', state: {} }).map((x) => x.state), ids.map(() => 'unknown'));
  // Details come only from saved coordinates and recorded events.
  const detailed = publicationStages({ status: 'publication_handoff', state: { storageAddress: 'stor-a' } }, {
    coordinates: { target: 'stor-b', expectedNonce: 3, reportedTxHash: null, observation: null, verifiedAt: null },
    history: [{ type: 'wallet_error', data: { message: 'first' } }, { type: 'wallet_error', data: { message: 'second' } }],
  });
  assert.deepEqual(detailed[2].detail, { storageAddress: 'stor-b', expectedNonce: 3, reportedTxHash: null, lastWalletError: 'second' });
  assert.equal(publicationStages({ status: 'chain_verified', state: {} }, { history: [{ type: 'wallet_error', data: { message: 'x' } }] })[2].detail.lastWalletError, null, 'a stale wallet error is shown only while the write is pending');
});

// ---------------- held testnet profile ----------------

test('config: testnet-held is a separate explicit profile; it needs an https non-loopback chain and an explicit network, and keeps embedded writes off', () => {
  const held = { ...BASE_ENV, DACS_EMBEDDED_WALLET_WRITES: 'testnet-held' };
  assert.throws(() => loadConfig(held), ConfigError, 'no chain');
  assert.throws(() => loadConfig({ ...held, DACS_CHAIN_RPC_URL: 'http://127.0.0.1:9', DACS_CHAIN_NETWORK: 'demos-testnet' }), ConfigError, 'loopback fixture chain');
  assert.throws(() => loadConfig({ ...held, DACS_CHAIN_RPC_URL: 'https://rpc.testnet.example' }), ConfigError, 'implicit network label');
  assert.throws(() => loadConfig({ ...held, DACS_CHAIN_RPC_URL: 'https://rpc.testnet.example', DACS_CHAIN_NETWORK: 'Demos Testnet' }), ConfigError, 'malformed network label');
  assert.throws(() => loadConfig({ ...held, DACS_CHAIN_RPC_URL: 'https://rpc.testnet.example', DACS_CHAIN_NETWORK: 'demos-testnet', DACS_EMBEDDED_WALLET_GITHUB_API_ORIGIN: 'http://127.0.0.1:9' }), ConfigError, 'fixture-only setting');
  // Accepting control.
  const ok = loadConfig({ ...held, DACS_CHAIN_RPC_URL: 'https://rpc.testnet.example', DACS_CHAIN_NETWORK: 'demos-testnet' });
  assert.deepEqual({ ...ok.embeddedWallet }, { writes: 'off', githubApiOrigin: null }, 'embedded writes stay off');
  assert.deepEqual({ ...ok.embeddedWalletTestnet }, { profile: 'held', executable: false, network: 'demos-testnet', rpcOrigin: 'https://rpc.testnet.example' });
  // Default and the simulated profile do not carry the testnet profile.
  assert.deepEqual({ ...loadConfig(BASE_ENV).embeddedWalletTestnet }, { profile: 'off' });
  assert.deepEqual({ ...loadConfig({ ...BASE_ENV, DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback', DACS_CHAIN_RPC_URL: 'http://127.0.0.1:9' }).embeddedWalletTestnet }, { profile: 'off' });
  assert.throws(() => loadConfig({ ...BASE_ENV, DACS_EMBEDDED_WALLET_WRITES: 'testnet' }), ConfigError, 'no implicit live value');
});

test('held testnet profile: the public profile says held, no relay is mounted, and nothing is sent upstream', async () => {
  const config = loadConfig({ ...BASE_ENV, DACS_EMBEDDED_WALLET_WRITES: 'testnet-held', DACS_CHAIN_RPC_URL: 'https://rpc.testnet.example', DACS_CHAIN_NETWORK: 'demos-testnet' });
  const outbound = [];
  const app = express();
  app.use(createWalletRpcRouter({ config, fetchImpl: async (...args) => { outbound.push(String(args[0])); throw new Error('no network in this test'); }, logger: null }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const profile = await post(origin, '/portal/api/embedded-wallet/profile');
    assert.equal(profile.status, 200);
    assert.deepEqual(profile.body, {
      writes: 'off',
      testnet: {
        profile: 'held', executable: false, network: 'demos-testnet',
        reason: 'held for the required independent security review and live gates; no testnet writes in this build',
        gates: ['security-review', 'live-wallet-compatibility', 'testnet-network-identity', 'human-approval'],
      },
    });
    // Not mounted: the default 404 (an HTML page), not a relay answer.
    const statusOf = async (path, body) => (await fetch(`${origin}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status;
    assert.equal(await statusOf('/portal/api/wallet-rpc'), 404);
    for (const body of [
      { method: 'nodeCall', params: [{ message: 'getAddressNonce', data: { address: `0x${'1'.repeat(64)}` } }] },
      { method: 'execute', params: [{ extra: 'broadcastTx', data: {} }] },
    ]) assert.equal(await statusOf('/portal/api/wallet-rpc', body), 404);
    assert.equal(await statusOf('/portal/api/wallet-rpc/github-user', { username: 'octo' }), 404);
    assert.deepEqual(outbound, [], 'no request left the process');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('held testnet transport in the real SDK session: every write answers held_for_review before any node call; message signing still works', { skip: SDK_BLOCKED }, async () => {
  const nodeTouches = [];
  class Recording extends sdk.Demos {
    async connect(url) { nodeTouches.push(`connect ${url}`); return super.connect(url); }
    async nodeCall(...args) { nodeTouches.push('nodeCall'); return super.nodeCall(...args); }
    async confirm(...args) { nodeTouches.push('confirm'); return super.confirm(...args); }
    async broadcast(...args) { nodeTouches.push('broadcast'); return super.broadcast(...args); }
  }
  const asked = [];
  const session = createSdkWalletSession({
    DemosCtor: Recording, IdentitiesCtor: sdk.Identities, validateMnemonic: sdk.validateMnemonic,
    transactionTransport: { profile: 'testnet-held', network: 'demos-testnet', rpcUrl: 'https://rpc.testnet.example' },
    approve: async (request) => { asked.push(request.method); return true; },
  });
  const account = await session.create();
  assert.equal(account.network, 'demos-testnet');
  assert.equal(account.evidenceMode, 'testnet-held-no-writes');
  assert.deepEqual(session.getWriteProfile(), {
    profile: 'testnet-held', network: 'demos-testnet', evidenceMode: 'testnet-held-no-writes', methods: [], transactionKinds: [], held: true,
    gates: ['security-review', 'live-wallet-compatibility', 'testnet-network-identity', 'human-approval'],
  });
  const storagePayload = { content: { type: 'storageProgram', from: account.address, to: `stor-${'0'.repeat(40)}`, amount: 0, nonce: 1, data: ['storageProgram', {}] } };
  for (const [method, params] of [['sendTransaction', [storagePayload]], ['addGithubIdentity', ['https://gist.github.com/a/1']], ['removeWeb2Identity', [{ context: 'github', username: 'a' }]], ['signTransaction', [{}]], ['pay', []]]) {
    const res = await session.request({ method, params });
    assert.equal(res.success, false, method);
    assert.equal(res.error.code, 'held_for_review', method);
    assert.match(res.error.message, /held for the required independent security review/);
  }
  assert.deepEqual(asked, [], 'no approval was even requested for a held write');
  const signed = await session.request({ method: 'sign', params: ['overnight-core held-profile sign check'] });
  assert.equal(signed.success, true, JSON.stringify(signed.error));
  assert.deepEqual(asked, ['sign']);
  session.lock();
  assert.equal((await session.request({ method: 'sendTransaction', params: [storagePayload] })).error.code, 'held_for_review');
  assert.deepEqual(nodeTouches, [], 'the held transport never reached a node');
});

test('default: an unconfigured session refuses the storage write (not_configured); the default profile stays exactly {writes:"off"}', { skip: SDK_BLOCKED }, async () => {
  const plain = await startHarness();
  try {
    assert.deepEqual((await post(plain.origin, '/portal/api/embedded-wallet/profile')).body, { writes: 'off' });
  } finally {
    await plain.close();
  }
  const session = createSdkWalletSession({ DemosCtor: sdk.Demos, IdentitiesCtor: sdk.Identities, validateMnemonic: sdk.validateMnemonic, approve: async () => true });
  const account = await session.create();
  assert.equal(session.getWriteProfile(), null);
  const res = await session.request({ method: 'sendTransaction', params: [{ content: { type: 'storageProgram', from: account.address } }] });
  assert.equal(res.error.code, 'not_configured');
  session.lock();
});

// ---------------- simulated publication with the real SDK ----------------

test('simulated profile advertises publication; the session lists the storage-program-create kind', { skip: SDK_BLOCKED }, async () => {
  const profile = (await post(h.origin, '/portal/api/embedded-wallet/profile')).body;
  assert.equal(profile.writes, 'simulated-loopback');
  assert.deepEqual(profile.capabilities, { payment: true, identity: false, publication: true });
  const wallet = await embedded();
  assert.deepEqual(wallet.session.getWriteProfile().transactionKinds, ['native-send', 'storage-program-create']);
  wallet.session.lock();
});

test('publication end to end: identity + listing signatures, one approved SDK storage write, chain readback, directory submission, directory visibility; a separate buyer discovers the NEW listing and buys it once', { skip: SDK_BLOCKED }, async () => {
  const seller = await sellerWithEmbedded();
  const unique = rand();
  const price = freshPrice();
  const title = `Overnight core service ${unique}`;
  const r = await registerSeller(seller, { title, priceDem: price });

  let view = (await pub(r, 'view')).body;
  assert.deepEqual(states(view), { identity_signature: 'action_required', listing_signature: 'pending', storage_write: 'pending', chain_readback: 'pending', directory_submission: 'pending', directory_visibility: 'pending' });
  const { listed, payload } = await signThrough(r, seller.wallet);
  assert.deepEqual(states(listed), { identity_signature: 'verified', listing_signature: 'verified', storage_write: 'action_required', chain_readback: 'pending', directory_submission: 'pending', directory_visibility: 'pending' });
  const op = payload.content.data[1];
  assert.equal(payload.content.type, 'storageProgram');
  assert.equal(payload.content.from, seller.wallet.address);
  assert.equal(payload.content.nonce, chain.nonceOf(seller.wallet.address) + 1, 'server fenced the next nonce');
  // Independent oracle for the address: the SDK's own StorageProgram.deriveStorageAddress.
  assert.equal(op.storageAddress, sdk.StorageProgram.deriveStorageAddress(seller.wallet.address, op.programName, payload.content.nonce, ''));
  assert.equal(stage(listed, 'storage_write').detail.storageAddress, op.storageAddress);

  const asked = seller.wallet.asked.length;
  const mark = chain.calls.length;
  const res = await seller.wallet.session.request({ method: 'sendTransaction', params: [payload] });
  assert.equal(res.success, true, JSON.stringify(res.error));
  assert.deepEqual(Object.keys(res.data).sort(), ['evidenceMode', 'hash', 'nonce', 'status']);
  assert.equal(res.data.status, 'broadcast_accepted');
  assert.equal(res.data.nonce, payload.content.nonce);

  // Exactly one deliberate approval showing the exact publication.
  const approvals = seller.wallet.asked.slice(asked);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].method, 'sendTransaction');
  const c = approvals[0].content;
  assert.deepEqual(
    { action: c.action, from: c.from, storageAddress: c.storageAddress, programName: c.programName, title: c.listing.title, price: c.listing.price, listingId: c.listing.listingId, sellerClaim: c.listing.sellerClaim, storageFeeDem: c.storageFeeDem, sdkGasDem: c.sdkGasDem, nonce: c.nonce },
    { action: 'publish DACS listing (storage program create)', from: seller.wallet.address, storageAddress: op.storageAddress, programName: op.programName, title, price: `${price} DEM (fixed)`, listingId: r.input.listingId, sellerClaim: `did:demos:agent:${seller.wallet.address.slice(2)}`, storageFeeDem: '1', sdkGasDem: '1', nonce: payload.content.nonce },
  );
  assert.match(c.evidence, /SIMULATED/);
  assert.match(approvals[0].purpose, new RegExp(title));

  // SDK wire through the relay: reads, confirm, exactly one broadcast; the
  // fixture stored the server-signed listing at the derived address.
  assert.deepEqual(executes(mark), ['execute:confirmTx', 'execute:broadcastTx']);
  assert.deepEqual(chain.broadcasts.at(-1), { hash: res.data.hash, applied: true, kind: 'storage-create' });
  const onChain = chain.txContent(res.data.hash);
  assert.equal(onChain.amount, '0', 'post-fork wire carries OS strings');
  assert.deepEqual(onChain.gcr_edits.filter((e) => e.type === 'balance').map((e) => e.amount), ['1000000000', '1000000000'], 'storage fee and SDK gas as approved');
  assert.equal(onChain.timestamp, payload.content.timestamp, 'the exact server payload was signed');
  const stored = chain.storageAt(op.storageAddress);
  assert.deepEqual(stored.data, op.data);
  assert.equal(stored.owner, seller.wallet.address);

  // A wallet result alone is not publication.
  view = (await pub(r, 'view')).body;
  assert.equal(view.status, 'publication_handoff');
  assert.equal(stage(view, 'storage_write').state, 'action_required');

  const reported = (await pub(r, 'report', { txHash: res.data.hash })).body;
  assert.equal(reported.status, 'chain_verified', JSON.stringify(reported.verification));
  assert.equal(reported.verification.outcome, 'verified');
  assert.equal(reported.verification.chainMode, 'simulated-fixture');
  assert.deepEqual(states(reported), { identity_signature: 'verified', listing_signature: 'verified', storage_write: 'verified', chain_readback: 'verified', directory_submission: 'action_required', directory_visibility: 'pending' });
  assert.equal(stage(reported, 'storage_write').detail.reportedTxHash, res.data.hash);
  assert.equal(stage(reported, 'chain_readback').detail.chainMode, 'simulated-fixture');

  // Directory registration signed by the embedded wallet.
  const reg = (await pub(r, 'registration')).body;
  const regSig = await seller.wallet.session.request({ method: 'sign', params: [reg.message] });
  const submitted = (await pub(r, 'register', { signedAt: reg.signedAt, signature: regSig.data.signature })).body;
  assert.equal(submitted.status, 'directory_submitted', JSON.stringify(submitted));
  assert.deepEqual(directory.registrations.at(-1).listingAnchors, [op.storageAddress]);
  assert.equal(stage(submitted, 'directory_submission').state, 'reported');
  assert.equal(stage(submitted, 'directory_visibility').state, 'waiting');

  // Submitted is not discoverable: the portal re-check says so until indexed.
  let checked = (await pub(r, 'verify')).body;
  assert.equal(checked.status, 'directory_submitted');
  assert.equal(checked.verification.directoryVisible, false);
  assert.equal(stage(checked, 'directory_visibility').state, 'waiting');
  assert.equal(directory.indexPending(), 1);
  checked = (await pub(r, 'verify')).body;
  assert.equal(checked.status, 'directory_visible', JSON.stringify(checked.verification));
  assert.equal(checked.verification.directoryVisible, true);
  assert.deepEqual(new Set(Object.values(states(checked))), new Set(['verified']));
  assert.equal(stage(checked, 'directory_visibility').detail.directoryMode, 'simulated-fixture');

  const status = await tool(h, seller.user, 'get_agent_status', { agentId: r.agentId });
  assert.equal(status.publicationStatus, 'directory_visible');
  assert.equal(status.onChainVerified, true);
  assert.equal(status.agentStatus, 'on_chain_simulated', 'fixture evidence is never labelled live');
  // The account-scoped service result carries the same stages for MCP use.
  const { accountId } = await tool(h, seller.user, 'get_account_status');
  assert.deepEqual(h.app.services.agents.get(accountId, r.agentId).stages, checked.stages);

  // A separate buyer discovers the NEW listing with its own title and price.
  const claim = `did:demos:agent:${seller.wallet.address.slice(2)}`;
  const found = await tool(h, null, 'search_agents', { query: unique });
  assert.ok(found.results.some((x) => x.listingId === r.input.listingId && x.seller === claim), JSON.stringify(found));
  const detail = await tool(h, null, 'get_listing', { listingId: r.input.listingId, version: 1, seller: claim });
  assert.equal(detail.transactable, true, JSON.stringify(detail.checks));
  assert.equal(detail.price.amount, price);
  assert.equal(sellerValue(detail.title), title);

  const buyer = await sellerWithEmbedded();
  const prepared = await tool(h, buyer.user, 'prepare_purchase', { listingId: r.input.listingId, version: 1, seller: claim, idempotencyKey: key('buy'), walletAddress: buyer.wallet.address });
  assert.equal(prepared.status, 'awaiting_approval', JSON.stringify(prepared));
  assert.equal(prepared.terms.amount, `${price} DEM`);
  assert.equal(prepared.terms.payee, seller.wallet.address);
  const url = new URL(prepared.approvalUrl);
  const pid = url.pathname.split('/').pop();
  const ptoken = new URLSearchParams(url.hash.slice(1)).get('t');
  const challenge = await post(h.origin, `/portal/api/purchase/${pid}/challenge`, { token: ptoken, address: buyer.wallet.address });
  const approval = await buyer.wallet.session.request({ method: 'sign', params: [challenge.body.message] });
  const approved = await post(h.origin, `/portal/api/purchase/${pid}/approve`, { token: ptoken, challengeId: challenge.body.challengeId, signature: approval.data.signature });
  assert.equal(approved.body.status, 'payment_handoff', JSON.stringify(approved.body));
  const paid = await buyer.wallet.session.request({ method: 'sendTransaction', params: [approved.body.payload] });
  assert.equal(paid.success, true, JSON.stringify(paid.error));
  assert.equal((await tool(h, buyer.user, 'get_purchase_status', { operationId: prepared.operationId })).status, 'payment_handoff', 'a wallet result alone is not settlement');
  const settled = await post(h.origin, `/portal/api/purchase/${pid}/report`, { token: ptoken, txHash: paid.data.hash });
  assert.equal(settled.body.status, 'settled_verified', JSON.stringify(settled.body.verification));
  assert.equal(settled.body.evidence.receipt.chainMode, 'simulated-fixture');
  seller.wallet.session.lock();
  buyer.wallet.session.lock();
});

test('publication on a pre-fork node (osDenomination not activated, DEM-number wire amounts): the same checks pass and exactly one write lands', { skip: SDK_BLOCKED }, async () => {
  const preChain = await startOvernightChain({ osDenominationActivated: false });
  const preDirectory = await startOvernightDirectory({ chain: preChain });
  const pre = await startHarness({ chain: preChain, directory: preDirectory, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
  const savedH = h;
  const savedChain = chain;
  try {
    h = pre;
    chain = preChain;
    const seller = await sellerWithEmbedded();
    const r = await registerSeller(seller);
    const { payload } = await signThrough(r, seller.wallet);
    const res = await seller.wallet.session.request({ method: 'sendTransaction', params: [payload] });
    assert.equal(res.success, true, JSON.stringify(res.error));
    assert.ok(preChain.calls.includes('nodeCall:getNetworkInfo'), 'the SDK asked the node for its fork status');
    assert.deepEqual(preChain.broadcasts.map((b) => [b.applied, b.kind]), [[true, 'storage-create']]);
    const onChain = preChain.txContent(res.data.hash);
    assert.equal(onChain.amount, 0, 'pre-fork wire keeps DEM numbers');
    assert.deepEqual(onChain.gcr_edits.filter((e) => e.type === 'balance').map((e) => e.amount), [1, 1], 'storage fee and gas as DEM numbers');
    assert.equal((await pub(r, 'report', { txHash: res.data.hash })).body.status, 'chain_verified');
    seller.wallet.session.lock();
  } finally {
    h = savedH;
    chain = savedChain;
    await pre.close();
  }
});

test('publication: rejecting the storage write sends nothing; the portal shows the write still pending, and the same nonce-fenced payload completes once', { skip: SDK_BLOCKED }, async () => {
  let rejectWrites = true;
  const seller = await sellerWithEmbedded((request) => request.method !== 'sendTransaction' || !rejectWrites);
  const r = await registerSeller(seller);
  const { payload } = await signThrough(r, seller.wallet);
  const mark = chain.calls.length;
  const rejected = await seller.wallet.session.request({ method: 'sendTransaction', params: [payload] });
  assert.deepEqual(rejected, { success: false, data: null, error: { code: 'user_rejected', message: 'the request was not approved; nothing was signed' } });
  assert.deepEqual(executes(mark), [], 'no confirm or broadcast');
  assert.equal(chain.storageAt(payload.content.to), null);
  const reportedReject = (await pub(r, 'report', { walletError: rejected.error.message })).body;
  assert.equal(reportedReject.status, 'publication_handoff');
  const view = (await pub(r, 'view')).body;
  assert.equal(stage(view, 'storage_write').state, 'action_required');
  assert.match(stage(view, 'storage_write').detail.lastWalletError, /not approved/);
  const resumed = (await pub(r, 'handoff')).body;
  assert.deepEqual(resumed.payload, payload, 'same payload, nonce and storage address');
  rejectWrites = false;
  const res = await seller.wallet.session.request({ method: 'sendTransaction', params: [resumed.payload] });
  assert.equal(res.success, true, JSON.stringify(res.error));
  assert.equal((await pub(r, 'report', { txHash: res.data.hash })).body.status, 'chain_verified');
  assert.equal(chain.broadcasts.filter((b) => b.hash === res.data.hash).length, 1);
  seller.wallet.session.lock();
});

test('publication: a lost broadcast answer after the write landed is outcome_unknown, never retried; the re-check verifies it from readback and no second write is offered', { skip: SDK_BLOCKED }, async () => {
  const seller = await sellerWithEmbedded();
  const r = await registerSeller(seller);
  const { payload } = await signThrough(r, seller.wallet);
  chain.faults.broadcastDropAfterApply = true;
  const mark = chain.calls.length;
  const attempts = chain.broadcasts.length;
  const unknown = await seller.wallet.session.request({ method: 'sendTransaction', params: [payload] });
  assert.equal(unknown.success, false);
  assert.equal(unknown.error.code, 'outcome_unknown');
  assert.equal(unknown.data.nonce, payload.content.nonce);
  assert.deepEqual(executes(mark), ['execute:confirmTx', 'execute:broadcastTx'], 'exactly one broadcast; no retry by SDK, relay or wallet');
  assert.equal(chain.broadcasts.length, attempts + 1);
  chain.resetFaults();
  assert.equal((await pub(r, 'report', { walletError: unknown.error.message })).body.status, 'publication_handoff', 'an unknown outcome is not reported as published');
  const checked = (await pub(r, 'verify')).body;
  assert.equal(checked.status, 'chain_verified', JSON.stringify(checked.verification));
  assert.equal(stage(checked, 'chain_readback').state, 'verified');
  const again = await pub(r, 'handoff');
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'invalid_state');
  assert.equal(chain.broadcasts.length, attempts + 1, 'nothing else was broadcast');
  seller.wallet.session.lock();
});

test('publication: a broadcast lost before it landed leaves the write pending; the same payload is re-issued and exactly one write lands', { skip: SDK_BLOCKED }, async () => {
  const seller = await sellerWithEmbedded();
  const r = await registerSeller(seller);
  const { payload } = await signThrough(r, seller.wallet);
  const attempts = chain.broadcasts.length;
  chain.faults.broadcastDropBeforeApply = true;
  const unknown = await seller.wallet.session.request({ method: 'sendTransaction', params: [payload] });
  assert.equal(unknown.error.code, 'outcome_unknown');
  chain.resetFaults();
  await pub(r, 'report', { walletError: unknown.error.message });
  const checked = (await pub(r, 'verify')).body;
  assert.equal(checked.status, 'publication_handoff');
  assert.equal(checked.verification.outcome, 'awaiting_readback');
  assert.equal(stage(checked, 'chain_readback').state, 'pending');
  const resumed = (await pub(r, 'handoff')).body;
  assert.deepEqual(resumed.payload, payload, 'nonce unchanged: the same write is re-issued, not a new one');
  const res = await seller.wallet.session.request({ method: 'sendTransaction', params: [resumed.payload] });
  assert.equal(res.success, true, JSON.stringify(res.error));
  assert.equal((await pub(r, 'report', { txHash: res.data.hash })).body.status, 'chain_verified');
  assert.deepEqual(chain.broadcasts.slice(attempts).map((b) => [b.applied, b.kind]), [[false, 'storage-create'], [true, 'storage-create']], 'one lost attempt, then exactly one applied write');
  assert.equal(chain.nonceOf(seller.wallet.address), payload.content.nonce, 'exactly one write consumed the nonce');
  seller.wallet.session.lock();
});

test('publication: if the wallet nonce is consumed by something else, the stage is unknown (not published) and the stale write is refused by the node, never broadcast', { skip: SDK_BLOCKED }, async () => {
  const seller = await sellerWithEmbedded();
  const r = await registerSeller(seller);
  const { payload } = await signThrough(r, seller.wallet);
  // An unrelated transfer from the same wallet takes the fenced nonce.
  const other = buildNativeTransferPayload({ from: seller.wallet.address, to: `0x${'3'.repeat(64)}`, amountOs: '1000000000', nonce: payload.content.nonce, timestamp: Date.now(), encoding: 'os-string' });
  const sent = await seller.wallet.session.request({ method: 'sendTransaction', params: [other] });
  assert.equal(sent.success, true, JSON.stringify(sent.error));
  const resumed = (await pub(r, 'handoff')).body;
  assert.equal(resumed.status, 'publication_uncertain', JSON.stringify(resumed));
  assert.equal(resumed.payload, null, 'no write is re-offered');
  assert.deepEqual([stage(resumed, 'storage_write').state, stage(resumed, 'chain_readback').state], ['unknown', 'waiting']);
  const attempts = chain.broadcasts.length;
  const mark = chain.calls.length;
  const stale = await seller.wallet.session.request({ method: 'sendTransaction', params: [payload] });
  assert.equal(stale.error.code, 'confirm_rejected', 'the node refuses the stale nonce at validation');
  assert.deepEqual(executes(mark), ['execute:confirmTx']);
  assert.equal(chain.broadcasts.length, attempts);
  assert.equal(chain.storageAt(payload.content.to), null);
  assert.equal((await pub(r, 'verify')).body.status, 'publication_uncertain');
  seller.wallet.session.lock();
});

test('publication payload boundaries: the valid payload reaches approval; each malformed or foreign variant is refused before approval and nothing is sent', { skip: SDK_BLOCKED }, async () => {
  const seller = await sellerWithEmbedded((request) => request.method !== 'sendTransaction');
  const r = await registerSeller(seller);
  const { payload } = await signThrough(r, seller.wallet);
  const mark = chain.calls.length;
  // Accepting control first: the exact server payload reaches one approval (declined here).
  let asked = seller.wallet.asked.length;
  const control = await seller.wallet.session.request({ method: 'sendTransaction', params: [payload] });
  assert.equal(control.error.code, 'user_rejected');
  assert.equal(seller.wallet.asked.length, asked + 1);
  asked = seller.wallet.asked.length;

  const variant = (mutate) => {
    const tx = structuredClone(payload);
    mutate(tx, tx.content.data[1]);
    return tx;
  };
  const other = `0x${'2'.repeat(64)}`;
  const shiftedAddress = sdk.StorageProgram.deriveStorageAddress(seller.wallet.address, payload.content.data[1].programName, payload.content.nonce + 1, '');
  const cases = [
    ['payload for another wallet', variant((tx) => { tx.content.from = other; }), 'wrong_wallet'],
    ['listing names another seller', variant((_tx, op) => { op.data.seller.identity.presentedBy = `did:demos:agent:${'2'.repeat(64)}`; }), 'wrong_wallet'],
    ['address derived for a different nonce', variant((tx, op) => { op.storageAddress = shiftedAddress; tx.content.to = shiftedAddress; }), 'invalid_params'],
    ['to differs from the storage address', variant((tx) => { tx.content.to = shiftedAddress; }), 'invalid_params'],
    ['program name not from the listing address', variant((_tx, op) => { op.programName = 'dacs1-b3RoZXI'; }), 'invalid_params'],
    ['unexpected payload field', variant((_tx, op) => { op.extra = true; }), 'invalid_params'],
    ['non-zero amount', variant((tx) => { tx.content.amount = 1; }), 'invalid_params'],
    ['nonce 0', variant((tx) => { tx.content.nonce = 0; }), 'invalid_params'],
    ['not a create', variant((_tx, op) => { op.operation = 'WRITE_STORAGE'; }), 'invalid_params'],
    ['owner-only ACL', variant((_tx, op) => { op.acl = { mode: 'owner' }; }), 'invalid_params'],
    ['binary encoding', variant((_tx, op) => { op.encoding = 'binary'; }), 'invalid_params'],
    ['empty params', null, 'invalid_params'],
  ];
  for (const [label, tx, code] of cases) {
    const res = await seller.wallet.session.request({ method: 'sendTransaction', params: tx ? [tx] : [] });
    assert.equal(res.success, false, label);
    assert.equal(res.error.code, code, `${label}: ${res.error.message}`);
  }
  assert.equal(seller.wallet.asked.length, asked, 'no malformed variant reached approval');
  assert.deepEqual(executes(mark), [], 'nothing was validated or broadcast');
  assert.equal(chain.storageAt(payload.content.to), null);
  seller.wallet.session.lock();
});

test('publication: after approval, an SDK-signed transaction that differs from the approved content is payload_mismatch and is never confirmed or broadcast (controlled SDK-seam faults)', { skip: SDK_BLOCKED }, async () => {
  for (const [label, alter] of [
    ['storage create edit removed', (signed) => { signed.content.gcr_edits = signed.content.gcr_edits.filter((e) => e.type !== 'storageProgram'); }],
    ['listing changed after approval', (signed) => { signed.content.data[1].data.offering.title = 'changed after approval'; }],
    ['storage fee changed', (signed) => { const burn = signed.content.gcr_edits.find((e) => e.type === 'balance'); burn.amount = typeof burn.amount === 'string' ? '2000000000' : 2; }],
  ]) {
    class Faulty extends sdk.Demos {
      async sign(tx, options) {
        const signed = await super.sign(tx, options);
        if (tx?.content?.type === 'storageProgram') alter(signed);
        return signed;
      }
    }
    const seller = await sellerWithEmbedded(undefined, { DemosCtor: Faulty });
    const r = await registerSeller(seller);
    const { payload } = await signThrough(r, seller.wallet);
    const mark = chain.calls.length;
    const res = await seller.wallet.session.request({ method: 'sendTransaction', params: [payload] });
    assert.equal(res.error?.code, 'payload_mismatch', `${label}: ${JSON.stringify(res)}`);
    assert.deepEqual(executes(mark), [], `${label}: nothing confirmed or broadcast`);
    assert.equal(chain.storageAt(payload.content.to), null, label);
    seller.wallet.session.lock();
  }
});

test('portal re-check route: needs the publication handoff token, reports not_handed_off before any write, and never changes state without evidence', { skip: SDK_BLOCKED }, async () => {
  const seller = await sellerWithEmbedded();
  const r = await registerSeller(seller);
  const wrong = await post(h.origin, `/portal/api/publish/${r.operationId}/verify`, { token: `${r.token.slice(0, -2)}xx` });
  assert.equal(wrong.status, 404);
  assert.equal(wrong.body.error, 'not_found');
  const missing = await post(h.origin, `/portal/api/publish/${r.operationId}/verify`, {});
  assert.equal(missing.status, 404);
  const early = (await pub(r, 'verify')).body;
  assert.equal(early.status, 'awaiting_identity_signature');
  assert.deepEqual(early.verification, { outcome: 'not_handed_off', status: 'awaiting_identity_signature' });
  const { payload } = await signThrough(r, seller.wallet);
  const pending = (await pub(r, 'verify')).body;
  assert.equal(pending.status, 'publication_handoff');
  assert.equal(pending.verification.outcome, 'awaiting_readback');
  assert.equal(chain.storageAt(payload.content.to), null);
  // Cancel is still allowed while nothing was written (existing rule).
  const cancelled = await tool(h, seller.user, 'cancel_wallet_handoff', { operationId: r.operationId });
  assert.equal(cancelled.status, 'cancelled');
  const view = (await pub(r, 'view')).body;
  assert.deepEqual(states(view), { identity_signature: 'verified', listing_signature: 'verified', storage_write: 'cancelled', chain_readback: 'pending', directory_submission: 'pending', directory_visibility: 'pending' });
  seller.wallet.session.lock();
});
