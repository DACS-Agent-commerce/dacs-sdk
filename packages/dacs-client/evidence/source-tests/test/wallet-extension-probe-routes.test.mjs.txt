import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { linkAccount, CookieJar, completeAuthorizationInBrowser, TestOAuthProvider } from './helpers/oauth.mjs';
import { auth } from '@modelcontextprotocol/client';
import { startHarness } from './helpers/harness.mjs';
import { startTestIssuer } from './fixtures/test-issuer.mjs';
import { contractView, runtimeNames } from './helpers/env-contract-view.mjs';

const base = { DACS_PUBLIC_ORIGIN: 'https://plugin.example', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(32) };
const hash = (v) => createHash('sha256').update(v).digest('hex');
// portal.js and portal.css include the purchased report view, which renders
// only when the shell carries data-showcase-report-view (DACS_SHOWCASE_REPORT_VIEW=1).
const legacy = {
  'index.html': '24c427d8701f35ce2510ef128679aaf3d96851f7bf7cd61d780df6043dde009e',
  // With the showcase ledger's import and its two mounts (they render nothing while DACS_SHOWCASE_LEDGER is off),
  // the seller identity panel (DACS_SELLER_IDENTITIES, off by default), the Agreement plan
  // step's status check after a plan-step error, and its warning kept to a step that may still run,
  // and pay() telling the buyer that a native payment cancelled meanwhile refused this attempt
  // (an earlier one may have been sent), why a handoff was refused before signing, and that a
  // purchase whose transfer has a cancelled payment's terms was not cancelled; its report
  // carries the wallet's error code; and the sign-in page's Warning row (only for a view with
  // clientNote, sent only with DACS_ALLOW_LOOPBACK_REDIRECTS=1). Plus the source change's api() error line, which
  // appends a refusal's buyerFunding sentence (unchanged output when a response carries none).
  'portal.js': 'bc196d593c804702efa257d8a45eadfc00a7547e907fc364cfa75ac1bcaa430c',
  'portal.css': '89a42fa639c0cdd45a5fdd51ec33a4a9fcb218f2017e8528615c263687d3cb49',
};

test('probe switch requires exactly 1, stays off by default, and its contract entry matches config', () => {
  assert.equal(loadConfig(base).walletExtensionProbe, false);
  for (const value of ['0', '', 'true', 'yes', '01']) assert.equal(loadConfig({ ...base, DACS_WALLET_EXTENSION_PROBE: value }).walletExtensionProbe, false);
  assert.equal(loadConfig({ ...base, DACS_WALLET_EXTENSION_PROBE: '1' }).walletExtensionProbe, true);
  const contract = contractView();
  assert.deepEqual(contract.variables.DACS_WALLET_EXTENSION_PROBE, { kind: 'flag', default: '0', note: 'Owner-run portal discovery and sign-only probes; never enables extension purchases', operator: true });
  assert.deepEqual(Object.keys(contract.variables).sort(), runtimeNames());
  assert.match(readFileSync(new URL('../deploy/dacs-chatgpt.env.example', import.meta.url), 'utf8'), /^DACS_WALLET_EXTENSION_PROBE=0$/m);
});

test('switch off hides every probe page/asset while legacy portal bytes and purchase hold stay identical to base', async () => {
  const h = await startHarness();
  try {
    for (const path of ['/portal/wallet-extension-probe', '/portal/wallet-extension-probe/assets/index.html', '/portal/wallet-extension-probe/assets/main.mjs', '/portal/wallet-extension-probe/assets/adapter.mjs', '/portal/wallet-extension-probe/assets/checks.mjs', '/portal/wallet-extension-probe/assets/vectors.mjs', '/portal/assets/wallet-extension-probe/index.html', '/portal/assets/%2e%2e/wallet-extension-probe/index.html']) {
      assert.equal((await fetch(`${h.origin}${path}`)).status, 404, path);
    }
    for (const path of ['/portal/link', '/portal/authorize/probe', '/portal/purchase/probe', '/portal/publish/probe', '/portal/identity/probe']) {
      const response = await fetch(`${h.origin}${path}`); assert.equal(response.status, 200); assert.equal(hash(await response.text()), legacy['index.html']);
    }
    for (const [file, digest] of Object.entries(legacy)) {
      assert.equal(hash(readFileSync(new URL(`../public/portal/${file}`, import.meta.url))), digest);
      assert.equal(hash(await (await fetch(`${h.origin}/portal/assets/${file}`)).text()), digest);
    }
    assert.equal(h.config.embeddedWallet.writes, 'off'); assert.equal(h.config.identityWrites, 'held');
  } finally { await h.close(); }
});

test('switch on serves only a separate CSP-protected probe page; normal portal and payment defaults remain identical', async () => {
  const {h,wallet}=await ownerHarness();
  try {
    const {provider}=await linkAccount({harness:h,wallet});
    const headers={authorization:`Bearer ${provider.tokens().access_token}`};
    const response = await fetch(`${h.origin}/portal/wallet-extension-probe`,{headers});
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Sign only/); assert.match(html, /\/portal\/wallet-extension-probe\/assets\/main.mjs/);
    assert.doesNotMatch(html, /src="\/portal\/assets\/portal.js"/);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    for (const file of ['main.mjs', 'adapter.mjs', 'checks.mjs', 'vectors.mjs']) {
      const asset = await fetch(`${h.origin}/portal/wallet-extension-probe/assets/${file}`,{headers}); assert.equal(asset.status, 200);
      assert.equal(await asset.text(), readFileSync(new URL(`../public/wallet-extension-probe/${file}`, import.meta.url), 'utf8'));
    }
    assert.equal((await fetch(`${h.origin}/portal/wallet-extension-probe`, { method: 'POST', body: '{}' })).status, 404, 'no report ingestion endpoint');
    assert.equal(hash(await (await fetch(`${h.origin}/portal/link`)).text()), legacy['index.html']);
    assert.equal(h.config.embeddedWallet.writes, 'off'); assert.equal(h.config.identityWrites, 'held');
  } finally { await h.close(); }
});

const ownerId = 'acct_aaaaaaaaaaaaaaaa';
async function ownerHarness(enabled='1', wallet=createEphemeralWallet()) {
  const h = await startHarness({ env: { DACS_WALLET_EXTENSION_PROBE: enabled, DACS_WALLET_EXTENSION_PROBE_OWNER_ACCOUNT: ownerId } });
  h.app.db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run(ownerId,h.config.builtinIssuer,ownerId,new Date().toISOString());
  h.app.services.accounts.linkWallet({ accountId: ownerId, address: wallet.address, challengeId: 'fixture' });
  return { h, wallet };
}
const probePaths = ['/portal/wallet-extension-probe', ...['index.html','main.mjs','adapter.mjs','checks.mjs','vectors.mjs'].map((file)=>`/portal/wallet-extension-probe/assets/${file}`)];
for (const [name, headers] of [['anonymous', {}], ['invalid bearer', { authorization: 'Bearer invalid' }], ['invalid session', { cookie: '_session=invalid; _session.sig=invalid' }]]) {
  test(`owner gate hides page and every asset from ${name}`, async () => {
    const { h } = await ownerHarness();
    try { for (const path of probePaths) { const r = await fetch(`${h.origin}${path}`, { headers }); assert.equal(r.status,404,path); assert.deepEqual(await r.json(),{error:'not_found'}); } }
    finally { await h.close(); }
  });
}
test('owner gate rejects a valid non-owner bearer and OAuth browser session', async () => {
  const { h } = await ownerHarness();
  try {
    const jar = new CookieJar(), provider = new TestOAuthProvider();
    await auth(provider,{serverUrl:h.mcpUrl});
    const callback = await completeAuthorizationInBrowser({ authorizationUrl:provider.authorizationUrl,wallet:createEphemeralWallet(),origin:h.origin,jar });
    await auth(provider,{serverUrl:h.mcpUrl,authorizationCode:callback.searchParams.get('code'),iss:callback.searchParams.get('iss')});
    for(const path of probePaths) for(const headers of [{authorization:`Bearer ${provider.tokens().access_token}`},{cookie:jar.header(`${h.origin}${path}`)}]) assert.equal((await fetch(`${h.origin}${path}`,{headers})).status,404);
  } finally { await h.close(); }
});
test('owner gate accepts the configured wallet owner bearer and existing OAuth browser session', async () => {
  const { h, wallet } = await ownerHarness();
  try {
    const jar = new CookieJar(), provider = new TestOAuthProvider();
    await auth(provider,{serverUrl:h.mcpUrl});
    const callback = await completeAuthorizationInBrowser({authorizationUrl:provider.authorizationUrl,wallet,origin:h.origin,jar});
    await auth(provider,{serverUrl:h.mcpUrl,authorizationCode:callback.searchParams.get('code'),iss:callback.searchParams.get('iss')});
    for(const path of probePaths) for(const headers of [{authorization:`Bearer ${provider.tokens().access_token}`},{cookie:jar.header(`${h.origin}${path}`)}]) assert.equal((await fetch(`${h.origin}${path}`,{headers})).status,200);
    assert.equal((await fetch(`${h.origin}/portal/wallet-extension-probe`,{headers:{authorization:'Bearer invalid',cookie:jar.header(h.origin)}})).status,404,'invalid bearer cannot fall back to session');
  } finally { await h.close(); }
});

test('switch off hides probes even from the authenticated configured owner', async () => {
  const {h,wallet}=await ownerHarness('0');
  try {const {provider}=await linkAccount({harness:h,wallet});for(const path of probePaths) assert.equal((await fetch(`${h.origin}${path}`,{headers:{authorization:`Bearer ${provider.tokens().access_token}`}})).status,404);}
  finally {await h.close();}
});
test('enabled probes with no configured owner remain hidden from valid accounts', async () => {
  const h=await startHarness({env:{DACS_WALLET_EXTENSION_PROBE:'1'}});
  try {const {provider}=await linkAccount({harness:h,wallet:createEphemeralWallet()});for(const path of probePaths) assert.equal((await fetch(`${h.origin}${path}`,{headers:{authorization:`Bearer ${provider.tokens().access_token}`}})).status,404);}
  finally {await h.close();}
});
test('probe nonce endpoint is read-only, owner-wallet bound and refuses unavailable or malformed nonces', async () => {
  const {h,wallet}=await ownerHarness();
  try {
    const {provider}=await linkAccount({harness:h,wallet}),headers={authorization:`Bearer ${provider.tokens().access_token}`};
    const url=`${h.origin}/portal/wallet-extension-probe/nonce/${wallet.address}`;
    assert.equal((await fetch(url)).status,404);assert.equal((await fetch(url,{headers:{authorization:'Bearer invalid'}})).status,404);
    h.chain.setNonce(wallet.address,7);h.chain.setBalance(wallet.address,'2500000000');
    assert.deepEqual(await (await fetch(url,{headers})).json(),{address:wallet.address,currentNonce:7,nextNonce:8,balanceOs:'2500000000'});
    for(const balance of ['-1','1.5',null]) {h.chain.setBalance(wallet.address,balance);assert.equal((await fetch(url,{headers})).status,500,`balance ${balance}`);}
    h.chain.setBalance(wallet.address,'2500000000');
    assert.equal((await fetch(`${h.origin}/portal/wallet-extension-probe/nonce/${createEphemeralWallet().address}`,{headers})).status,404);
    for(const nonce of [-1,1.5,Number.MAX_SAFE_INTEGER]) {h.chain.setNonce(wallet.address,nonce);assert.equal((await fetch(url,{headers})).status,500);}
    h.chain.setNonce(wallet.address,7);
    assert.equal((await fetch(url,{method:'POST',headers})).status,404);
    assert.equal(h.chain.nonceOf(wallet.address),7,'reads never consume nonce');
  } finally {await h.close();}
});

// an earlier review. A page's module and fetch subrequests never carry a bearer header,
// so only the built-in issuer's session cookie can load the probe in a browser.
const externalRefusal = JSON.stringify({ error: 'not_found' });
test('the probe is built-in sign-in only: a browser session loads it, an external issuer refuses every probe route', async () => {
  const wallet = createEphemeralWallet(), nonce = `/portal/wallet-extension-probe/nonce/${wallet.address}`;
  const { h } = await ownerHarness('1', wallet);
  try {
    const jar = new CookieJar(), provider = new TestOAuthProvider();
    await auth(provider,{serverUrl:h.mcpUrl});
    await completeAuthorizationInBrowser({authorizationUrl:provider.authorizationUrl,wallet,origin:h.origin,jar});
    h.chain.setNonce(wallet.address,7);h.chain.setBalance(wallet.address,'1');
    for (const path of [...probePaths, nonce]) assert.equal((await fetch(`${h.origin}${path}`,{headers:{cookie:jar.header(`${h.origin}${path}`)}})).status,200,`built-in session ${path}`);
  } finally { await h.close(); }
  const issuer = await startTestIssuer();
  const x = await startHarness({ env: { DACS_AUTH_MODE: 'external', DACS_OAUTH_ISSUER: issuer.issuer, DACS_OAUTH_COOKIE_KEYS: '', DACS_WALLET_EXTENSION_PROBE: '1', DACS_WALLET_EXTENSION_PROBE_OWNER_ACCOUNT: ownerId } });
  try {
    assert.equal(x.logs.filter((line) => line.includes('wallet_extension_probe_requires_builtin_sign_in')).length, 1, 'startup warning reaches the app logger');
    x.app.db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run(ownerId,issuer.issuer,'probe-owner',new Date().toISOString());
    x.app.services.accounts.linkWallet({ accountId: ownerId, address: wallet.address, challengeId: 'fixture' });
    x.chain.setNonce(wallet.address,7);x.chain.setBalance(wallet.address,'1');
    issuer.state.subject = 'probe-owner';
    const scope = 'dacs.account.read', provider = new TestOAuthProvider({ scope });
    assert.equal(await auth(provider,{serverUrl:x.mcpUrl,scope}),'REDIRECT');
    const callback = new URL((await fetch(provider.authorizationUrl,{redirect:'manual'})).headers.get('location'));
    assert.equal(await auth(provider,{serverUrl:x.mcpUrl,authorizationCode:callback.searchParams.get('code'),iss:callback.searchParams.get('iss'),scope}),'AUTHORIZED');
    // Even the verified owner's bearer is refused, so no probe byte is served.
    for (const path of [...probePaths, nonce]) for (const headers of [{ authorization: `Bearer ${provider.tokens().access_token}` }, {}]) {
      const r = await fetch(`${x.origin}${path}`, { headers });
      assert.equal(r.status, 404, path); assert.equal(await r.text(), externalRefusal, path);
    }
    for (const path of ['/health', '/portal/link']) assert.doesNotMatch(await (await fetch(`${x.origin}${path}`)).text(), /extension-probe/, path);
  } finally { await x.close(); await issuer.close(); }
});
