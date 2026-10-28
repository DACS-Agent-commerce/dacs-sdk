// The real operator at its defaults on the owned loopback Node2 chain, up to
// the Agreement plan (the step DACS_SELLER_CONTEXT changes). Keys, job ids and
// times differ on every run, so this records the shape (keys, types and
// counts, recursing into JSON text) of what the step produces: the tool and
// portal outputs, the operator's seller approval prompts, the purchase row and
// its history, every row of every SQLite journal, and the approval logs; and
// the same values with only the run-specific ones replaced (valuesOf). Only
// APIs that main already has are used, so the same file runs on main and on
// this branch; seller-context-route-off.test.mjs pins what main produced.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { auth } from '@modelcontextprotocol/client';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { startOperatorPurchaseNode2 } from './devnet-operator-purchase-node2.mjs';
import { openTestWalletCustody } from '../../src/devnet-demo/operator-custody.mjs';
import { CookieJar, TestOAuthProvider } from './oauth.mjs';
import { tool, portal, tokenFrom } from './flows.mjs';

// Object keys that are data (an origin with its random port, a random grant id,
// a key naming a job or a party, such as the party Vet store's operation keys)
// become numbered placeholders, ordered by their values' shapes.
const dataKey = (key) => key.includes('://') || /^[A-Za-z0-9_-]{32,}$/.test(key) || /01[0-9A-HJKMNP-TV-Z]{24}|[0-9a-f]{16,}/i.test(key);
export function shapeOf(value) {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Uint8Array) return 'bytes';
  if (Array.isArray(value)) return value.map(shapeOf);
  if (typeof value === 'object') {
    const named = Object.keys(value).filter((key) => !dataKey(key)).sort().map((key) => [key, shapeOf(value[key])]);
    const data = Object.keys(value).filter(dataKey).map((key) => shapeOf(value[key])).sort((a, b) => canonicalize(a).localeCompare(canonicalize(b)));
    return Object.fromEntries([...named, ...data.map((shape, index) => [`<data-key-${index}>`, shape])]);
  }
  if (typeof value === 'string' && /^[[{]/.test(value)) { try { return { json: shapeOf(JSON.parse(value)) }; } catch { /* plain text */ } }
  return typeof value;
}

// The values themselves, with only what differs between runs replaced by its
// kind: keys, hashes and signatures, base64url tokens, account, purchase,
// OAuth and job ids, times, and the random loopback ports. Statuses, kinds,
// authorities, prompt and notice text, fees, sizes, counts and every other
// deterministic value stay as they are, so a changed value (not only a changed
// shape) changes the digest.
const VOLATILE = [
  [/(?:https?:\/\/)?127\.0\.0\.1:\d+/g, '<loopback>'],
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<iso-time>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/01[0-9A-HJKMNP-TV-Z]{24}/g, '<job>'],
  [/\b(pur|acct|chl)_[A-Za-z0-9_-]{16}(?![A-Za-z0-9_-])/g, '$1_<id>'],
  [/#t=[A-Za-z0-9_-]+/g, '#t=<token>'],
  [/\b(nonce|client|interaction): [A-Za-z0-9_-]+/g, '$1: <token>'],
  [/(?:0x)?[0-9a-f]{16,}/gi, '<hex>'],
  // Random base64url of 40 or more characters (signatures, OAuth ids) always mixes cases.
  [/[A-Za-z0-9_-]{40,}/g, (token) => /[A-Z]/.test(token) && /[a-z]/.test(token) ? '<token>' : token],
];
// String values that are random ids or key material whatever their length.
const VOLATILE_KEYS = new Set(['id', 'operationId', 'operation_id', 'accountId', 'account_id', 'clientId', 'client_id', 'grantId', 'grant_id', 'jti', 'uid', 'sessionUid', 'sid', 'nonce',
  'link_challenge_id', 'challengeId', 'challenge_id', 'signature', 'd', 'x', 'y', 'p', 'q', 'qi', 'dp', 'dq', 'n', 'kid']);
const volatileNumber = (value) => (value >= 1e12 && value < 1e13) || (value >= 1.6e9 && value < 2.2e9);
// Signed bytes kept as JSON ({"0": 123, ...}) hold keys and hashes too.
const byteObject = (value) => Object.keys(value).length > 0 && Object.entries(value).every(([key, byte]) => /^\d+$/.test(key) && Number.isInteger(byte) && byte >= 0 && byte <= 255);
export function valuesOf(value) {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Uint8Array) return 'bytes';
  if (Array.isArray(value) && value.length >= 32 && byteObject({ ...value })) return 'bytes';
  if (Array.isArray(value)) return value.map(valuesOf);
  if (typeof value === 'object' && byteObject(value)) return 'bytes';
  if (typeof value === 'object') {
    const named = Object.keys(value).filter((key) => !dataKey(key)).sort().map((key) => [key, VOLATILE_KEYS.has(key) && typeof value[key] === 'string' ? '<id>' : valuesOf(value[key])]);
    const data = Object.keys(value).filter(dataKey).map((key) => valuesOf(value[key])).sort((a, b) => canonicalize(a).localeCompare(canonicalize(b)));
    return Object.fromEntries([...named, ...data.map((entry, index) => [`<data-key-${index}>`, entry])]);
  }
  if (typeof value === 'number') return Number.isInteger(value) && volatileNumber(value) ? '<time>' : value;
  if (typeof value === 'string' && /^[[{]/.test(value)) { try { return { json: valuesOf(JSON.parse(value)) }; } catch { /* plain text */ } }
  if (typeof value === 'string') return VOLATILE.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
  return value;
}

export async function linkAccount({ origin, mcpUrl, address, signHex }) {
  const scope = 'dacs.account.read dacs.purchases.write', callbackUrl = `${origin}/operator/oauth/callback`;
  class Provider extends TestOAuthProvider { get redirectUrl() { return callbackUrl; } get clientMetadata() { return { ...super.clientMetadata, redirect_uris: [callbackUrl] }; } }
  const provider = new Provider({ scope }), jar = new CookieJar();
  const follow = async (start) => {
    let url = new URL(start);
    for (let i = 0; i < 12; i++) {
      if (url.href.startsWith(callbackUrl)) return url;
      const response = await fetch(url, { redirect: 'manual', headers: { cookie: jar.header(url) } }); jar.store(response);
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) return url; url = new URL(location, url);
    }
    throw new Error('TEST OAuth redirect bound exceeded');
  };
  assert.equal(await auth(provider, { serverUrl: mcpUrl, scope }), 'REDIRECT');
  const page = await follow(provider.authorizationUrl), uid = /\/portal\/authorize\/([^/?#]+)/.exec(page.pathname)?.[1];
  const api = async (action, body) => {
    const url = `${origin}/portal/authorize/${uid}/api/${action}`, response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', cookie: jar.header(url) }, body: JSON.stringify(body) });
    jar.store(response); const out = await response.json(); assert.equal(response.status, 200, JSON.stringify(out)); return out;
  };
  const challenge = await api('challenge', { address }), done = await api('complete', { challengeId: challenge.challengeId, signature: signHex(challenge.message) });
  const callback = await follow(done.redirectTo);
  assert.equal(await auth(provider, { serverUrl: mcpUrl, authorizationCode: callback.searchParams.get('code'), iss: callback.searchParams.get('iss'), scope }), 'AUTHORIZED');
  return provider;
}

const files = (directory, suffix) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(directory, entry.name), suffix) : entry.name.endsWith(suffix) ? [join(directory, entry.name)] : []).sort();

// Main's seller-state process leases (seller-durable-state.mjs, #74) are not
// journals: each live process holds its own, under a random name, in an
// exclusive transaction until it exits, so they are neither readable nor stable.
const lease = (stateDirectory, path) => /^seller-state[\\/]holders[\\/][^\\/]+\.sqlite$/.test(relative(stateDirectory, path));

function journals(stateDirectory) {
  const out = {};
  for (const path of files(stateDirectory, '.sqlite').filter((path) => !lease(stateDirectory, path))) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
      out[relative(stateDirectory, path)] = Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all().map((row) => ({ ...row }))]));
    } finally { db.close(); }
  }
  for (const path of files(stateDirectory, '.jsonl')) out[relative(stateDirectory, path)] = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return out;
}

// Returns {h, operation, outputs, prompts, journal, shape, digest, values,
// valuesDigest}. The caller closes h.
export async function operatorPlanAtDefaults() {
  const prompts = [];
  const h = await startOperatorPurchaseNode2({ authorizeSellerApproval: (input) => { prompts.push(structuredClone(input)); return true; } });
  try {
    const origin = h.config.publicOrigin, mcpUrl = `${origin}/mcp`;
    const custody = await openTestWalletCustody({ directory: h.config.custodyDirectory, role: 'buyer', publicOrigin: origin });
    try {
      const provider = await linkAccount({ origin, mcpUrl, address: custody.signer.address, signHex: (message) => custody.signer.signBytes(Buffer.from(message)).toString('hex') });
      const harness = { origin, mcpUrl };
      const prepared = await tool(harness, { provider }, 'prepare_purchase', { listingId: h.config.listing.listingId, version: 1, seller: h.prepared.operatorEvidence.seller, idempotencyKey: 'seller-context-defaults', protocol: 'dacs-sr2-wallet-agreement' });
      assert.equal(prepared.status, 'agreement_pending', JSON.stringify(prepared));
      const api = (action, body = {}) => portal(harness, `/portal/api/purchase/${prepared.operationId}/agreement/${action}`, { token: tokenFrom(prepared.approvalUrl), ...body });
      const identity = await api('identity', { address: custody.signer.address });
      assert.equal(identity.error, undefined, JSON.stringify(identity));
      const planned = await api('plan', { signature: custody.signer.signBytes(Buffer.from(identity.signRequest.message)).toString('hex') });
      assert.equal(planned.error, undefined, JSON.stringify(planned));
      const accountId = h.application.services.accounts.walletOwner(custody.signer.address);
      const operation = h.application.services.ops.get(accountId, prepared.operationId);
      const history = h.application.services.ops.history(prepared.operationId);
      const outputs = { prepared, identity, planned };
      const journal = journals(h.config.stateDirectory);
      const shape = shapeOf({ outputs, prompts, operation, history, journal });
      const values = valuesOf({ outputs, prompts, operation, history, journal });
      return { h, operation, outputs, prompts, journal, shape, digest: sha256Hex(canonicalize(shape)), values, valuesDigest: sha256Hex(canonicalize(values)) };
    } finally { custody.close(); }
  } catch (error) { await h.close(); throw error; }
}
