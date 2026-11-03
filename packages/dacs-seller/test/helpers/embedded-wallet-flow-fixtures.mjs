// Fixtures for the embedded wallet FLOW acceptance tests (built-in fixed-price
// payment and GitHub/Twitter identity add/remove). See
// docs/EMBEDDED-WALLET-FLOW-COVERAGE.md for clauses and evidence tiers.
//
// Evidence tiers (never merged into one claim):
//  - W wire-shape fixture: the loopback SIMULATED chain below answers the
//    Demos SDK 4.0.16 RPC envelope ({method, params:[{type, message, data,
//    extra}]} -> {result, response, require_reply, extra}).
//  - S real SDK signing: transactions are signed only by the official SDK. The
//    fixture never signs; it independently VERIFIES sha256(serialized content)
//    and the ed25519 signature with node:crypto before accepting a write.
//  - Real testnet: not covered here.
// Source-aware functional tests; not a security review and not live proof.
// Keys are fresh per test and RAM-only; mnemonics are never printed.
import http from 'node:http';
import net from 'node:net';
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

export const REQUIRE = process.env.DACS_EMBEDDED_WALLET_REQUIRE === '1';

// ---------------------------------------------------------------------------
// Core public interface: the ONLY place these tests depend on the new core
// surface. Source: evidence/CORE-INTERFACE-PRELIMINARY.md (core's PRELIMINARY
// public contract, not yet frozen or accepted). Expected outcomes in the tests
// are independent of it; only names/shapes come from here.
// ---------------------------------------------------------------------------
export const PROFILE = 'simulated-loopback';
export const CORE_INTERFACE = Object.freeze({
  // §1: default off; the simulated profile needs a loopback DACS_CHAIN_RPC_URL.
  // Identity writes still need the existing simulated-fixture-only flag.
  enableEnv: ({ githubApiOrigin } = {}) => ({
    DACS_EMBEDDED_WALLET_WRITES: PROFILE,
    DACS_IDENTITY_WRITES: 'simulated-fixture-only',
    ...(githubApiOrigin ? { DACS_EMBEDDED_WALLET_GITHUB_API_ORIGIN: githubApiOrigin } : {}),
  }),
  // §2 same-origin routes.
  routes: Object.freeze({ profile: '/portal/api/embedded-wallet/profile', rpc: '/portal/api/wallet-rpc', githubUser: '/portal/api/wallet-rpc/github-user' }),
  // §4 exact error codes.
  codes: Object.freeze({
    rejected: 'user_rejected', locked: 'locked', notConfigured: 'not_configured', unknown: 'outcome_unknown',
    confirmRejected: 'confirm_rejected', broadcastRejected: 'broadcast_rejected',
  }),
});

// §2: the server's public profile for the embedded wallet.
export async function fetchProfile(h) {
  const res = await fetch(`${h.origin}${CORE_INTERFACE.routes.profile}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return { ...(await res.json().catch(() => ({}))), httpStatus: res.status };
}

// §3: transactionTransport is a plain object {profile, rpcUrl, network,
// resolveGithubUser?}. Built from the server profile, so the SDK talks to the
// real same-origin relay (/portal/api/wallet-rpc), which forwards to the
// loopback fixture chain; GitHub users resolve through the relay's
// github-user route, which reads the loopback GitHub API fixture.
export function transportFromProfile(h, profile) {
  const lookups = [];
  return {
    profile: profile.writes,
    rpcUrl: profile.rpcUrl,
    network: profile.network,
    async resolveGithubUser(username) {
      lookups.push(username);
      const res = await fetch(`${h.origin}${CORE_INTERFACE.routes.githubUser}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username }) });
      if (!res.ok) throw new Error(`github-user relay answered HTTP ${res.status}`);
      return res.json();
    },
    get lookups() {
      return lookups;
    },
  };
}

// SIMULATED stand-in for the GitHub user API on loopback.
// Public data shape only ({login, id}); never forwards anywhere.
export async function startGithubApiFixture() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const match = /^\/users\/([A-Za-z0-9-]{1,39})$/.exec(new URL(req.url, 'http://fixture').pathname);
    const headers = { 'content-type': 'application/json', 'x-dacs-simulation': 'fixture', connection: 'close' };
    if (req.method !== 'GET' || !match) return res.writeHead(404, headers).end(JSON.stringify({ message: 'Not Found', simulated: true }));
    const login = match[1];
    const id = Number.parseInt(sha256(login).slice(0, 8), 16);
    return res.writeHead(200, headers).end(JSON.stringify({ login, id, simulated: true }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

// ---------------------------------------------------------------------------
// Loopback-only network guard: any connection to a non-loopback host (e.g.
// api.github.com through SDK addGithubIdentity, or X through getTweet) is
// recorded and refused before DNS. Install once per test file.
// ---------------------------------------------------------------------------
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
export const externalAttempts = [];
let guardInstalled = false;
export function installLoopbackOnlyGuard() {
  if (guardInstalled) return externalAttempts;
  guardInstalled = true;
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const first = args[0];
    const opts = Array.isArray(first) ? first[0] : first;
    let host;
    if (opts && typeof opts === 'object') host = opts.path ? 'ipc' : (opts.host ?? 'localhost');
    else if (typeof first === 'number' || /^\d+$/.test(String(first))) host = typeof args[1] === 'string' ? args[1] : 'localhost';
    else host = 'ipc';
    if (host !== 'ipc' && !LOOPBACK.has(String(host).replace(/^\[|\]$/g, ''))) {
      externalAttempts.push(String(host));
      throw new Error(`non-loopback connection refused in embedded wallet flow tests: ${host}`);
    }
    return original.apply(this, args);
  };
  return externalAttempts;
}

// ---------------------------------------------------------------------------
// Installed SDK (public npm @kynesyslabs/demosdk 4.0.16 in wallet-build/).
// ---------------------------------------------------------------------------
const buildDir = new URL('../../wallet-build/', import.meta.url);
const sdkDir = new URL('node_modules/@kynesyslabs/demosdk/', buildDir);
export const SDK_PRESENT = existsSync(new URL('package.json', sdkDir));
export const SDK_MISSING_REASON = SDK_PRESENT ? null : 'BLOCKED: wallet-build dependencies are not installed';

// Same scoped resolve hook as test/embedded-wallet-sdk.test.mjs: the published
// build uses bundler-style specifiers; SDK bytes are loaded unmodified.
let hooked = false;
function hookSdkResolution() {
  if (hooked) return;
  hooked = true;
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
}

export async function loadInstalledSdk() {
  if (!SDK_PRESENT) throw new Error(SDK_MISSING_REASON);
  hookSdkResolution();
  const require = createRequire(new URL('package.json', buildDir));
  const version = JSON.parse(readFileSync(new URL('package.json', sdkDir), 'utf8')).version;
  if (version !== '4.0.16') throw new Error(`expected @kynesyslabs/demosdk 4.0.16, found ${version}`);
  const { Demos } = await import(pathToFileURL(require.resolve('@kynesyslabs/demosdk/websdk')).href);
  const { Identities } = await import(new URL('build/abstraction/Identities.js', sdkDir).href);
  const { validateMnemonic: bip39Validate } = await import(pathToFileURL(require.resolve('@scure/bip39')).href);
  const { wordList } = await import(new URL('build/encryption/PQC/falconts/wordlist.js', sdkDir).href);
  const validateMnemonic = (m) => typeof m === 'string' && bip39Validate(m, wordList);
  return { Demos, Identities, validateMnemonic, version };
}

// A fresh SDK wallet (tier S): the SDK derives the key and signs. The mnemonic
// stays in this closure and is only exposed for secret-absence probes.
export async function createSdkWallet(sdk, { rpcUrl } = {}) {
  const demos = new sdk.Demos();
  const mnemonic = demos.newMnemonic(256);
  await demos.connectWallet(mnemonic, { algorithm: 'ed25519' });
  if (rpcUrl) await demos.connect(rpcUrl);
  const address = String(demos.getAddress()).toLowerCase();
  return {
    demos,
    address,
    secretProbe: () => mnemonic,
    async signHex(message) {
      const signed = await demos.signMessage(message, { algorithm: 'ed25519' });
      return String(signed.data).replace(/^0x/, '');
    },
  };
}

// Mirrors public/portal/portal.js findHash (the extension-compatible reader).
export function portalFindHash(value, depth = 0) {
  if (depth <= 1 && typeof value === 'string') return /^(0x)?[0-9a-fA-F]{64}$/.test(value) ? value : null;
  if (depth > 4 || value == null || typeof value !== 'object') return null;
  for (const key of ['hash', 'txHash', 'transactionHash']) {
    if (typeof value[key] === 'string' && /^(0x)?[0-9a-fA-F]{64}$/.test(value[key])) return value[key];
  }
  for (const key of ['data', 'response', 'result']) {
    const hit = portalFindHash(value[key], depth + 1);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// SIMULATED Demos chain speaking the SDK 4.0.16 wire. Every response carries
// x-dacs-simulation: fixture so the plugin labels evidence as simulated.
// ---------------------------------------------------------------------------
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const strip0x = (s) => String(s ?? '').toLowerCase().replace(/^0x/, '');

function verifyEd25519(publicKeyHex, message, signatureHex) {
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(strip0x(publicKeyHex), 'hex').toString('base64url') }, format: 'jwk' });
    return edVerify(null, Buffer.from(message, 'utf8'), key, Buffer.from(strip0x(signatureHex), 'hex'));
  } catch {
    return false;
  }
}

export async function startSdkChainFixture({ postFork = true } = {}) {
  const nonces = new Map();
  const storage = new Map();
  const txs = new Map();
  const blocks = [];
  const identities = new Map();
  const record = { rpc: [], confirms: [], broadcastAttempts: [], applied: [], rejections: [] };
  // broadcastMode: 'ok' | 'reject-confirm' (definite: confirm says invalid) |
  // 'apply-then-503' (applied, but the answer is lost: outcome unknown).
  const faults = { broadcastMode: 'ok', unavailable: false };
  let clock = Math.floor(Date.now() / 1000);

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'x-dacs-simulation': 'fixture', connection: 'close' });
    res.end(JSON.stringify(body));
  };
  const envelope = (response) => ({ result: 200, response, require_reply: false, extra: null });

  function checkSigned(tx) {
    const content = tx?.content;
    if (!content || typeof tx.hash !== 'string') return 'missing content or hash';
    if (sha256(JSON.stringify(content)) !== tx.hash) return 'hash is not sha256 of the serialized content';
    if (tx.signature?.type !== 'ed25519' || !verifyEd25519(content.from, tx.hash, tx.signature?.data)) return 'ed25519 signature does not verify for content.from';
    if (strip0x(content.from) !== strip0x(content.from_ed25519_address)) return 'from and from_ed25519_address differ';
    const current = nonces.get(`0x${strip0x(content.from)}`) ?? 0;
    if (content.nonce !== current + 1) return `nonce ${content.nonce} is not ${current + 1}`;
    return null;
  }

  function apply(tx) {
    const content = structuredClone(tx.content);
    const from = `0x${strip0x(content.from)}`;
    nonces.set(from, (nonces.get(from) ?? 0) + 1);
    clock += 5;
    const block = { number: blocks.length, txs: [tx.hash], timestamp: clock };
    blocks.push(block);
    txs.set(tx.hash, { hash: tx.hash, content, blockNumber: block.number, failed: false });
    if (content.type === 'identity') {
      const op = content.data?.[1];
      const p = op?.payload ?? {};
      const entry = identities.get(from) ?? { web2: {}, xm: {} };
      if (op?.method === 'web2_identity_assign' && ['github', 'twitter'].includes(p.context)) {
        entry.web2[p.context] = [...(entry.web2[p.context] ?? []), { proof: p.proof ?? null, userId: p.userId ?? null, username: p.username, proofHash: p.proof ? sha256(p.proof) : null, timestamp: clock }];
      } else if (op?.method === 'web2_identity_remove' && entry.web2[p.context]) {
        entry.web2[p.context] = entry.web2[p.context].filter((i) => i.username.toLowerCase() !== String(p.username).toLowerCase());
      }
      identities.set(from, entry);
    }
    record.applied.push({ hash: tx.hash, type: content.type, from, to: content.to, amount: content.amount, nonce: content.nonce });
  }

  function nodeCall(message, data) {
    switch (message) {
      case 'getAddressNonce':
        return nonces.get(String(data.address).toLowerCase()) ?? 0;
      case 'getNetworkInfo':
        return { forks: { osDenomination: { activated: postFork, activationHeight: 0 } }, chainHead: blocks.length, simulated: true };
      case 'getNetworkParameters':
        return { networkFee: 0, rpcFee: 0, simulated: true };
      case 'getAddressInfo':
        return { balance: '1000000000000' };
      case 'getTweet': {
        // SIMULATED: the handle is read from the post URL itself; nothing is fetched from X.
        const m = /^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})$/.exec(String(data.tweetUrl ?? ''));
        if (!m) return { success: false, tweet: null, error: 'SIMULATED: not a post URL' };
        return { success: true, tweet: { userId: `simulated-${sha256(m[1]).slice(0, 8)}`, username: m[1] } };
      }
      case 'getTransactionStatus': {
        const tx = txs.get(String(data.hash).toLowerCase());
        return tx ? { state: tx.failed ? 'failed' : 'included', blockNumber: tx.blockNumber } : { state: 'not-found' };
      }
      case 'getTxByHash': {
        const tx = txs.get(String(data.hash).toLowerCase());
        return tx ? { hash: tx.hash, content: tx.content, status: 'confirmed', blockNumber: tx.blockNumber } : null;
      }
      case 'getBlockByNumber': {
        const block = blocks[data.blockNumber];
        return block ? { number: block.number, status: 'confirmed', content: { ordered_transactions: block.txs, timestamp: block.timestamp } } : null;
      }
      default:
        return undefined;
    }
  }

  const server = http.createServer(async (req, res) => {
    if (faults.unavailable) return send(res, 503, { error: 'unavailable', simulated: true });
    const url = new URL(req.url, 'http://fixture');
    const storageMatch = /^\/storage-program\/(stor-[0-9a-f]{40})$/.exec(url.pathname);
    if (req.method === 'GET' && storageMatch) {
      const entry = storage.get(storageMatch[1]);
      if (!entry) return send(res, 404, { success: false, error: 'not found' });
      return send(res, 200, { success: true, data: entry.data, owner: entry.owner, programName: entry.programName });
    }
    // Demos.connect(rpc) does a plain GET of the RPC URL.
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, { simulated: true, note: 'SIMULATED Demos RPC fixture' });
    if (req.method !== 'POST' || url.pathname !== '/') return send(res, 404, { error: 'not found' });
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return send(res, 400, { result: 400, response: 'bad json' });
    }
    const call = parsed?.params?.[0];
    if (parsed?.method === 'gcr_routine') {
      record.rpc.push(`gcr_routine:${call?.method}`);
      if (call?.method !== 'getIdentities') return send(res, 200, { result: 400, response: 'unknown routine' });
      const entry = identities.get(String(call?.params?.[0] ?? '').toLowerCase()) ?? { web2: {}, xm: {} };
      return send(res, 200, { result: 200, response: { xm: structuredClone(entry.xm), web2: structuredClone(entry.web2), ud: [], pqc: {} } });
    }
    if (parsed?.method === 'execute') {
      record.rpc.push(`execute:${call?.extra}`);
      if (call?.extra === 'confirmTx') {
        const tx = call.data;
        record.confirms.push(tx?.hash ?? null);
        const problem = faults.broadcastMode === 'reject-confirm' ? 'simulated definite rejection' : checkSigned(tx);
        if (problem) {
          record.rejections.push(problem);
          return send(res, 200, envelope({ data: { valid: false, reference_block: blocks.length, message: `SIMULATED: ${problem}`, gas_operation: null, transaction: tx }, signature: { type: 'ed25519', data: '' }, rpc_public_key: '' }));
        }
        return send(res, 200, envelope({ data: { valid: true, reference_block: blocks.length, message: 'SIMULATED fixture: transaction is valid', gas_operation: null, transaction: tx }, signature: { type: 'ed25519', data: '' }, rpc_public_key: '' }));
      }
      if (call?.extra === 'broadcastTx') {
        const tx = call.data?.response?.data?.transaction;
        record.broadcastAttempts.push(tx?.hash ?? null);
        if (tx?.hash && txs.has(tx.hash)) return send(res, 200, envelope({ message: 'SIMULATED: already included', txHash: tx.hash }));
        const problem = checkSigned(tx);
        if (problem) {
          record.rejections.push(problem);
          return send(res, 200, { result: 400, response: `SIMULATED: ${problem}`, require_reply: false, extra: null });
        }
        apply(tx);
        if (faults.broadcastMode === 'apply-then-503') return send(res, 503, { error: 'simulated: response lost after the write was applied' });
        return send(res, 200, envelope({ message: 'SIMULATED fixture: broadcast accepted', txHash: tx.hash }));
      }
      return send(res, 200, { result: 400, response: 'unknown execute extra' });
    }
    if (parsed?.method === 'nodeCall') {
      record.rpc.push(call?.message);
      const response = nodeCall(call?.message, call?.data ?? {});
      if (response === undefined) return send(res, 200, { result: 400, response: 'unknown method' });
      return send(res, 200, envelope(response));
    }
    return send(res, 200, { result: 400, response: 'unknown method' });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    record,
    faults,
    // Test-only: the next mined payment must follow a finalized SR-2 write.
    advanceTo(timestampMs) {
      if (!Number.isSafeInteger(timestampMs) || timestampMs < 1e12) throw new RangeError('fixture timestamp must be epoch milliseconds (at least 1e12)');
      clock = Math.max(clock, Math.ceil(timestampMs / 1000));
    },
    txs,
    identities,
    nonceOf: (address) => nonces.get(address.toLowerCase()) ?? 0,
    setNonce: (address, value) => nonces.set(address.toLowerCase(), value),
    // Test-only seeds (same surface as test/fixtures/chain-server.mjs).
    seedStorage(address, { data, owner, programName = 'fixture' }) {
      storage.set(address, { data: structuredClone(data), owner: owner.toLowerCase(), programName });
    },
    seedWeb2Identity(address, context, { username, userId = null, proof = null }) {
      const key = address.toLowerCase();
      const entry = identities.get(key) ?? { web2: {}, xm: {} };
      entry.web2[context] = [...(entry.web2[context] ?? []), { proof, userId, username, proofHash: proof ? sha256(proof) : null, timestamp: clock }];
      identities.set(key, entry);
    },
    web2Handles(address, context) {
      return (identities.get(address.toLowerCase())?.web2[context] ?? []).map((e) => e.username);
    },
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

// ---------------------------------------------------------------------------
// Account helpers over the real plugin portal API.
// ---------------------------------------------------------------------------
async function post(h, path, body) {
  const res = await fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  // httpStatus is kept apart: portal views carry their own `status` field.
  return { ...(await res.json()), httpStatus: res.status };
}

// Links an SDK-held wallet to an existing account through the one-time wallet
// link (start_wallet_link + /portal/api/link/*), signed by `signHex`.
export async function linkWalletViaPortal(h, linkUrl, { address, signHex }) {
  const f = new URLSearchParams(new URL(linkUrl).hash.slice(1));
  const body = { accountId: f.get('a'), expires: Number(f.get('e')), nonce: f.get('n'), token: f.get('t') };
  const challenge = await post(h, '/portal/api/link/challenge', { ...body, address });
  if (challenge.httpStatus !== 200) throw new Error(`link challenge failed: ${challenge.error}`);
  const done = await post(h, '/portal/api/link/complete', { ...body, challengeId: challenge.challengeId, signature: await signHex(challenge.message) });
  if (done.httpStatus !== 200) throw new Error(`link complete failed: ${done.error}`);
  return done;
}

export { post as portalPost };
