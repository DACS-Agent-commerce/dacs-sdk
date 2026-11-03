// Focused unit tests for pure modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../src/config.mjs';
import { decodeSignature, normalizeDemosAddress, verifyDemosSignature, claimForAddress, addressForClaim } from '../src/wallet/demos-signature.mjs';
import { createChallengeService, PURPOSES } from '../src/wallet/challenges.mjs';
import { openDatabase } from '../src/store/database.mjs';
import { projectSummary } from '../src/dacs/directory.mjs';
import { createRateLimiter } from '../src/util/rate-limit.mjs';
import { createLogger } from '../src/util/log.mjs';
import { encodeNativeAmount, deriveStorageAddress, communityProgramName } from '../src/dacs/wallet-transactions.mjs';
import { purchaseSupport, normalizeDemAmount } from '../src/dacs/listing.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { contractView, runtimeNames } from './helpers/env-contract-view.mjs';

const base ={ DACS_PUBLIC_ORIGIN: 'https://plugin.example', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(32) };

test('report view flag defaults off, enables only with 1, and is a static contract entry the runtime reads', async () => {
  assert.equal(loadConfig(base).showcaseReportView, false);
  for (const value of ['', '0', 'true', 'yes', '2']) assert.equal(loadConfig({ ...base, DACS_SHOWCASE_REPORT_VIEW: value }).showcaseReportView, false);
  assert.equal(loadConfig({ ...base, DACS_SHOWCASE_REPORT_VIEW: '1' }).showcaseReportView, true);
  const { readFileSync } = await import('node:fs');
  const { contractView, runtimeNames } = await import('./helpers/env-contract-view.mjs');
  const { envNamesFromSource, readSwitchRegistry } = await import('../deploy/scripts/lib/rules.mjs');
  // Static (docs/SWITCHES.md): its rule involves DACS_SHOWCASE_LEDGER, so it is
  // listed in env-contract.json and has no switch file.
  const contract = JSON.parse(readFileSync(new URL('../deploy/env-contract.json', import.meta.url)));
  assert.deepEqual(contract.variables.DACS_SHOWCASE_REPORT_VIEW, { kind: 'flag', default: '0', operator: true });
  assert.deepEqual(contractView().variables.DACS_SHOWCASE_REPORT_VIEW, { kind: 'flag', default: '0', operator: true });
  assert.ok(runtimeNames().includes('DACS_SHOWCASE_REPORT_VIEW'));
  // The rule reads the ledger switch's parsed value: src/config.mjs reads no switch's env name itself.
  const { fileURLToPath } = await import('node:url');
  const switches = Object.keys(readSwitchRegistry(fileURLToPath(new URL('../', import.meta.url))).entries);
  assert.ok(switches.includes('DACS_SHOWCASE_LEDGER') && !switches.includes('DACS_SHOWCASE_REPORT_VIEW'));
  assert.deepEqual(envNamesFromSource(readFileSync(new URL('../src/config.mjs', import.meta.url), 'utf8')).filter((name) => switches.includes(name)), []);
  assert.match(readFileSync(new URL('../deploy/dacs-chatgpt.env.example', import.meta.url), 'utf8'), /^DACS_SHOWCASE_REPORT_VIEW=0$/m);
});

test('config: https origins, explicit opt-in for loopback http, required secrets', () => {
  assert.equal(loadConfig(base).mcpUrl, 'https://plugin.example/mcp');
  assert.throws(() => loadConfig({ ...base, DACS_PUBLIC_ORIGIN: 'http://plugin.example' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, DACS_PUBLIC_ORIGIN: 'http://127.0.0.1:1' }), ConfigError);
  assert.equal(loadConfig({ ...base, DACS_PUBLIC_ORIGIN: 'http://127.0.0.1:1', DACS_ALLOW_INSECURE_LOCALHOST: '1' }).publicOrigin, 'http://127.0.0.1:1');
  assert.throws(() => loadConfig({ ...base, DACS_PUBLIC_ORIGIN: 'https://plugin.example/sub' }), /bare origin/);
  assert.throws(() => loadConfig({ DACS_PUBLIC_ORIGIN: 'https://plugin.example' }), /DACS_OAUTH_COOKIE_KEYS/);
  assert.throws(() => loadConfig({ ...base, DACS_OAUTH_COOKIE_KEYS: 'short' }), /at least 32/);
  assert.throws(() => loadConfig({ ...base, DACS_AUTH_MODE: 'external' }), /DACS_OAUTH_ISSUER/);
  assert.throws(() => loadConfig({ ...base, DACS_DIRECTORY_ORIGIN: 'http://directory.example' }), /https/);
  assert.throws(() => loadConfig({ ...base, DACS_DEM_AMOUNT_ENCODING: 'float' }), ConfigError);
  const c = loadConfig(base);
  assert.equal(c.directory, null, 'unconfigured live dependencies are explicit nulls, never fixtures');
  assert.equal(c.chain, null);
});

test('config: loopback OAuth redirects default off and require the exact opt-in', () => {
  assert.equal(loadConfig(base).allowLoopbackRedirects, false);
  for (const value of ['', '0', 'true', 'yes']) assert.equal(loadConfig({ ...base, DACS_ALLOW_LOOPBACK_REDIRECTS: value }).allowLoopbackRedirects, false);
  const config = loadConfig({ ...base, DACS_ALLOW_LOOPBACK_REDIRECTS: '1' });
  assert.equal(config.allowLoopbackRedirects, true);
  assert.equal(config.allowInsecureLocal, false);
  assert.deepEqual(config.allowedRedirectOrigins, ['https://chatgpt.com']);
  assert.deepEqual(config.cimdAllowedHosts, ['chatgpt.com']);
  // src/switches/DACS_ALLOW_LOOPBACK_REDIRECTS.switch: no deploy value, so a deployment may turn it on.
  const contract = contractView();
  assert.deepEqual(contract.variables.DACS_ALLOW_LOOPBACK_REDIRECTS, { kind: 'flag', default: '0', note: 'native clients only; exact HTTP loopback hosts, any port', operator: true });
  assert.deepEqual(Object.keys(contract.variables).sort(), runtimeNames());
});

test('config: starting from the unedited .env.example fails clearly', async () => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const env = Object.fromEntries(text.split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.throws(() => loadConfig(env), /DACS_OAUTH_COOKIE_KEYS still contains an example placeholder/);
  assert.throws(() => loadConfig({ ...base, DACS_OAUTH_COOKIE_KEYS: `REPLACE_ME${'x'.repeat(40)}` }), /placeholder/, 'a long placeholder is still refused');
  assert.throws(() => loadConfig({ ...base, DACS_OAUTH_COOKIE_KEYS: 'replace-with-a-long-random-secret-at-least-32-chars' }), /placeholder/);
});

test('wallet signatures: Community encodings accepted, everything else rejected', () => {
  const w = createEphemeralWallet();
  const sig = w.signHex('hello');
  assert.equal(decodeSignature(sig).length, 64);
  assert.equal(decodeSignature(`0x${sig}`).length, 64, 'doubled 0x quirk');
  assert.equal(decodeSignature(decodeSignature(sig).toString('base64url')).length, 64);
  assert.throws(() => decodeSignature('ab'.repeat(63)));
  assert.equal(verifyDemosSignature({ address: w.address, message: 'hello', signature: sig }), true);
  assert.equal(verifyDemosSignature({ address: w.address, message: 'hello!', signature: sig }), false);
  assert.equal(verifyDemosSignature({ address: createEphemeralWallet().address, message: 'hello', signature: sig }), false);
  assert.equal(verifyDemosSignature({ address: 'garbage', message: 'hello', signature: sig }), false);
  assert.equal(normalizeDemosAddress(w.address.toUpperCase().replace('0X', '0x')), w.address);
  assert.equal(addressForClaim(claimForAddress(w.address)), w.address);
  assert.throws(() => addressForClaim(`did:demos:agent:${'A'.repeat(64)}`));
});

test('challenges: rendered bindings, expiry and purpose separation', () => {
  const db = openDatabase(':memory:');
  let now = Date.parse('2026-10-01T00:00:00Z');
  const svc = createChallengeService({ db, origin: 'https://plugin.example', ttlSeconds: 60, now: () => now });
  const w = createEphemeralWallet();
  const c = svc.issue({ purpose: PURPOSES.LOGIN, address: w.address, binding: { interaction: 'abc', client: 'cid' } });
  assert.match(c.message, /^plugin\.example requests a DACS wallet signature/);
  for (const part of ['origin: https://plugin.example', 'purpose: account-login', `address: ${w.address}`, 'client: cid', 'interaction: abc', 'expires-at: 2026-10-01T00:01:00.000Z']) assert.ok(c.message.includes(part), part);
  assert.throws(() => svc.verifyAndConsume({ challengeId: c.challengeId, purpose: PURPOSES.LINK_WALLET, expectedBinding: {}, signature: w.signHex(c.message), consumedBy: 'x' }), /different purpose/);
  assert.throws(() => svc.verifyAndConsume({ challengeId: c.challengeId, purpose: PURPOSES.LOGIN, expectedBinding: { client: 'other' }, signature: w.signHex(c.message), consumedBy: 'x' }), /binding client/);
  now += 61_000;
  assert.throws(() => svc.verifyAndConsume({ challengeId: c.challengeId, purpose: PURPOSES.LOGIN, expectedBinding: {}, signature: w.signHex(c.message), consumedBy: 'x' }), /expired/);
  assert.throws(() => svc.issue({ purpose: PURPOSES.LOGIN, address: w.address, binding: { evil: 'line\nbreak' } }), /single-line/);
  db.close();
});

test('directory projection whitelists and caps fields', () => {
  const good = {
    listingId: 'x-1', version: 1, contentHash: 'a'.repeat(64), anchor: { kind: 'storage-program', locator: `stor-${'b'.repeat(40)}` },
    seller: { primaryClaim: `did:demos:agent:${'c'.repeat(64)}`, displayName: 'S'.repeat(500) }, offering: { title: 'T', tags: ['a', 7, 'b'] },
    status: 'active', injected: '<script>', pricing: {},
  };
  const p = projectSummary(good);
  assert.equal(p.seller.displayName.length, 200);
  assert.deepEqual(p.tags, ['a', 'b']);
  assert.equal(p.injected, undefined);
  for (const bad of [{ ...good, contentHash: 'zz' }, { ...good, anchor: { kind: 'x', locator: 'y' } }, { ...good, status: 'weird' }, { ...good, seller: { primaryClaim: 'demos:0xabc' } }]) assert.equal(projectSummary(bad), null);
});

test('payload helpers: denomination encoding and Community storage addressing', () => {
  assert.equal(encodeNativeAmount('2500000000', 'os-string'), '2500000000');
  assert.equal(encodeNativeAmount('3000000000', 'dem-number'), 3);
  assert.throws(() => encodeNativeAmount('2500000000', 'dem-number'), /whole DEM/);
  assert.match(deriveStorageAddress(`0x${'a'.repeat(64)}`, 'dacs1-x', 1), /^stor-[0-9a-f]{40}$/);
  assert.equal(communityProgramName('dacs1:a:b:v1'), `dacs1-${Buffer.from('dacs1:a:b:v1').toString('base64url')}`);
  assert.deepEqual(normalizeDemAmount('1.5'), { amount: '1.5', amountOs: '1500000000' });
  assert.throws(() => normalizeDemAmount('0'));
  assert.throws(() => normalizeDemAmount('1.0000000001'));
  // At most 78 OS digits, as a node balance (chain.mjs OS_DIGITS_MAX); zeros are canonicalized first.
  assert.equal(normalizeDemAmount(`${'9'.repeat(69)}.999999999`).amountOs, '9'.repeat(78));
  assert.equal(normalizeDemAmount(`${'0'.repeat(100)}1.5${'0'.repeat(100)}`).amountOs, '1500000000');
  assert.throws(() => normalizeDemAmount('9'.repeat(70)), /longer than any Demos balance/);
  assert.throws(() => normalizeDemAmount('9'.repeat(10_000)), /longer than any Demos balance/);
  assert.equal(purchaseSupport({ pricing: { kind: 'fixed', price: { amount: '1', currency: 'USDC' } } }).supported, false);
});

test('rate limiter answers 429 with retry-after past the limit', () => {
  let t = 0;
  const limit = createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
  const res = { headers: {}, statusCode: 200, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.statusCode = c; return this; }, json() { return this; } };
  let passed = 0;
  for (let i = 0; i < 3; i += 1) limit({ ip: '192.0.2.1' }, res, () => passed++);
  assert.equal(passed, 2);
  assert.equal(res.statusCode, 429);
  t = 1001;
  limit({ ip: '192.0.2.1' }, res, () => passed++);
  assert.equal(passed, 3);
});

test('logger drops sensitive fields', () => {
  const lines = [];
  const log = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
  log.info('x', { access_token: 'secret', authorization: 'Bearer y', signature: 'z', path: '/mcp' });
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.path, '/mcp');
  assert.equal(parsed.access_token, undefined);
  assert.equal(parsed.authorization, undefined);
  assert.equal(parsed.signature, undefined);
});
