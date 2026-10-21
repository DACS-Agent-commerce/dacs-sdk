// DACS_INTENT_APPROVAL: off by default, and off means the build without the
// feature: every portal asset byte for byte (the files on disk carry no
// hooks), the same 404s for the intent assets and routes, the same MCP tool
// list and the same wallet dialogs. On: hooks inserted at fixed anchors.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { loadConfig } from '../src/config.mjs';
import { INTENT_HOOKS, INTENT_HOOK_ASSETS, applyIntentHooks } from '../src/portal/intent-hooks.mjs';
import { startHarness } from './helpers/harness.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { linkAccount } from './helpers/oauth.mjs';
import { covers } from '../public/portal-intent/start.mjs';

const PUBLIC = fileURLToPath(new URL('../public/portal/', import.meta.url));
const files = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [relative(PUBLIC, join(dir, name))]));
const base = { DACS_PUBLIC_ORIGIN: 'http://127.0.0.1:8787', DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(64) };

let off;
let on;
before(async () => {
  off = await startHarness();
  on = await startHarness({ env: { DACS_INTENT_APPROVAL: 'on' } });
});
after(async () => { await off.close(); await on.close(); });

const get = async (h, path) => {
  const r = await fetch(`${h.origin}${path}`);
  return { status: r.status, type: r.headers.get('content-type'), cache: r.headers.get('cache-control'), csp: r.headers.get('content-security-policy'), body: Buffer.from(await r.arrayBuffer()) };
};
const post = async (h, path, body) => {
  const r = await fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.text() };
};

test('the switch is off by default and accepts only off or on', () => {
  assert.equal(loadConfig(base).intentApproval, 'off');
  assert.equal(loadConfig({ ...base, DACS_INTENT_APPROVAL: 'on' }).intentApproval, 'on');
  for (const value of ['', 'true', 'ON', '1', 'embedded']) assert.throws(() => loadConfig({ ...base, DACS_INTENT_APPROVAL: value }), /DACS_INTENT_APPROVAL/);
});

test('switch off: every portal asset is the file as shipped, with no hook; switch on: the hooked assets get their hooks', async () => {
  const all = files(PUBLIC);
  const hooked = applyIntentHooks(PUBLIC);
  assert.deepEqual([...hooked.keys()].sort(), [...INTENT_HOOK_ASSETS].sort());
  for (const name of all) {
    const file = readFileSync(join(PUBLIC, name));
    assert.doesNotMatch(file.toString('latin1'), /intent\{|\}intent|startIntent|approvePurchaseIntent|portal-intent/, `${name}: no trace of the feature on disk`);
    const served = await get(off, `/portal/assets/${name}`);
    assert.equal(served.status, 200, name);
    assert.ok(served.body.equals(file), `${name}: switch-off bytes are the file`);
    const raw = await get(on, `/portal/assets/${name}`);
    assert.ok(raw.body.equals(hooked.get(name)?.body ?? file), `${name}: switch-on bytes`);
    assert.equal(served.type, raw.type, `${name}: same content type`);
    assert.equal(served.cache, raw.cache, `${name}: same cache-control`);
    assert.equal(served.csp, raw.csp, `${name}: same CSP`);
  }
  for (const hook of INTENT_HOOKS) assert.equal(hooked.get(hook.asset).body.toString('utf8').split(hook.replacement).length, 2, `${hook.name} lands once`);
});

test('switch off: the intent assets and routes do not exist (same answers as anything missing)', async () => {
  for (const name of readdirSync(new URL('../public/portal-intent/', import.meta.url))) {
    // A 404 names the path it looked for; public/portal/intent/ is missing on main too.
    const missingAsset = await get(off, `/portal/assets/no-such-dir/${name}`);
    missingAsset.body = Buffer.from(missingAsset.body.toString('utf8').replaceAll('/no-such-dir/', '/intent/'), 'utf8');
    const asset = await get(off, `/portal/assets/intent/${name}`);
    assert.equal(asset.status, missingAsset.status, name);
    assert.equal(asset.type, missingAsset.type, name);
    assert.ok(asset.body.equals(missingAsset.body), name);
    assert.equal((await get(on, `/portal/assets/intent/${name}`)).status, 200, `${name} is served when on`);
  }
  const missingRoute = await post(off, '/portal/api/purchase/pur_x/no-such-step', {});
  for (const step of ['intent/start', 'intent/plan', 'intent/sign']) {
    assert.deepEqual(await post(off, `/portal/api/purchase/pur_x/${step}`, {}), missingRoute, step);
    assert.notEqual((await post(on, `/portal/api/purchase/pur_x/${step}`, {})).body, missingRoute.body, `${step} exists when on`);
  }
});

test('the MCP tool list is the same with the switch on and off', async () => {
  const list = async (h) => {
    const client = new Client({ name: 'intent-switch', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(h.mcpUrl)));
    try { return (await client.listTools()).tools; } finally { await client.close(); }
  };
  const [a, b] = [await list(off), await list(on)];
  assert.ok(a.length > 0);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('other wallets never reach the Start: only the unlocked embedded wallet with a covered profile does', () => {
  const terms = { protocol: { profile: 'dacs-chatgpt-plugin/fixed-price-pay-dem/v1', jobId: '01M4F1QVZYWQKAXBWNQPHZXXZT' }, domain: { mode: 'simulated-fixture' } };
  assert.equal(covers({ provider: { request() {} }, terms }), false, 'an extension provider');
  assert.equal(covers({ provider: { isDacsEmbeddedWallet: true, isLocked: () => false }, terms }), false, 'no embedded wallet session opened through the intent bridge');
  const source = applyIntentHooks(PUBLIC).get('portal.js').body.toString('utf8');
  const hook = INTENT_HOOKS.find((h) => h.name === 'embedded-start-branch').replacement;
  assert.match(hook, /^ {4}needBoundWallet\(t\);\n {4}\/\/ Embedded wallet only[^\n]*\n {4}if \(walletSource === 'embedded' && startIntent\?\.covers\(\{ provider, terms: t \}\)\) \{/);
  // The per-step flow runs after main's own checks (payment network, bound wallet).
  assert.ok(source.indexOf('needPaymentNetwork(t);\n    needBoundWallet(t);\n    // Embedded wallet only') > 0);
});

test('switch on with the owner probe and showcase on: Start hooks stay on the purchase assets only', async (t) => {
  const ownerId = 'acct_aaaaaaaaaaaaaaaa';
  const h = await startHarness({ env: { DACS_INTENT_APPROVAL: 'on', DACS_WALLET_EXTENSION_PROBE: '1', DACS_WALLET_EXTENSION_PROBE_OWNER_ACCOUNT: ownerId, DACS_SHOWCASE_WALKTHROUGH: 'on', DACS_SHOWCASE_LEDGER: '1', DACS_SHOWCASE_PUBLICATION_VIEW: '1' } });
  t.after(() => h.close());
  assert.deepEqual([h.config.intentApproval, h.config.walletExtensionProbe, h.config.showcaseWalkthrough, h.config.showcaseLedger, h.config.showcasePublicationView], ['on', true, 'on', true, true]);
  const wallet = createEphemeralWallet();
  h.app.db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run(ownerId, h.config.builtinIssuer, ownerId, new Date().toISOString());
  h.app.services.accounts.linkWallet({ accountId: ownerId, address: wallet.address, challengeId: 'fixture' });
  const { provider } = await linkAccount({ harness: h, wallet });
  const headers = { authorization: `Bearer ${provider.tokens().access_token}` };
  const hooked = applyIntentHooks(PUBLIC);
  for (const name of files(PUBLIC)) {
    const served = await get(h, `/portal/assets/${name}`);
    assert.equal(served.status, 200, name);
    assert.ok(served.body.equals(hooked.get(name)?.body ?? readFileSync(join(PUBLIC, name))), `${name}: all switches preserve the Start hooks`);
  }
  for (const name of readdirSync(new URL('../public/portal-intent/', import.meta.url))) {
    const served = await get(h, `/portal/assets/intent/${name}`);
    assert.equal(served.status, 200, name);
    assert.ok(served.body.equals(readFileSync(new URL(`../public/portal-intent/${name}`, import.meta.url))), name);
  }
  for (const name of readdirSync(new URL('../public/wallet-extension-probe/', import.meta.url))) {
    const response = await fetch(`${h.origin}/portal/wallet-extension-probe/assets/${name}`, { headers });
    assert.equal(response.status, 200, name);
    assert.equal(await response.text(), readFileSync(new URL(`../public/wallet-extension-probe/${name}`, import.meta.url), 'utf8'), `${name}: the separate probe stays unhooked`);
  }
  assert.equal((await fetch(`${h.origin}/portal/wallet-extension-probe`, { headers })).status, 200);
  assert.equal((await get(h, '/portal/wallet-extension-probe')).status, 404, 'the owner gate still applies');
  for (const name of readdirSync(new URL('../public/showcase/', import.meta.url))) {
    const served = await get(h, `/portal/showcase/${name}`);
    assert.equal(served.status, 200, name);
    assert.ok(served.body.equals(readFileSync(new URL(`../public/showcase/${name}`, import.meta.url))), `${name}: the read-only showcase stays unhooked`);
  }
  assert.ok((await get(h, '/portal/purchase/TEST')).body.equals(readFileSync(join(PUBLIC, 'index.html'))));
});
