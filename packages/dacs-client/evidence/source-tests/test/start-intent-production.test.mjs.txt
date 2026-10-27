import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { applyIntentHooks } from '../src/portal/intent-hooks.mjs';
const servedProvider = applyIntentHooks(fileURLToPath(new URL('../public/portal/', import.meta.url))).get('embedded-wallet/sdk-provider.mjs').body;
const servedProviderUrl = `data:text/javascript;base64,${servedProvider.toString('base64')}`;
import { fixturePurchase, withListingHash, viewFor, identityFor, gatedWallet, hookedProvider } from './helpers/start-intent.mjs';
import { buildIntent, DEVNET_CREATE_KIND } from '../public/portal-intent/intent.mjs';
const { EmbeddedWalletError } = hookedProvider;
import { attachIdentityPresentation } from '../src/dacs/listing.mjs';
import { planAgreement } from '../src/dacs/purchase-protocol.mjs';
// Load the production module and all its gate/flow code. Only the browser UI
// and SDK session factory are substituted at the absolute browser URLs; the
// SDK provider's URL loads the real module.
const hooks = registerHooks({ resolve(specifier, context, next) {
  const sources = {
    // As the switch-on hook makes it: the session's SDK class comes from fenceSdk.
    // unhooked: a bridge without that hook (it ignores fenceSdk).
    '/portal/assets/embedded-wallet-bridge.mjs': 'export const sessionFactory = args => { const p = globalThis.__intentProduction; p.DemosCtor = args.fenceSdk && !p.unhooked ? args.fenceSdk(class { async signMessage(m) { return { type: "ed25519", data: m }; } }) : null; return p.factory(args); };',
    '/portal/assets/embedded-wallet/ui.mjs': 'export const createIndexedDbVaultStore = () => ({get: async () => null}); export const createMemoryVaultStore = () => ({}); export const mountEmbeddedWallet = (root, options) => {globalThis.__intentProduction.options = options; return {};};',
    '/portal/assets/seller-session-delegation.mjs': 'export const checkSellerSessionDelegation = () => {};',
  };
  if (sources[specifier]) return { url: 'data:text/javascript,' + encodeURIComponent(sources[specifier]), shortCircuit: true };
  if (specifier === '/portal/assets/embedded-wallet/sdk-provider.mjs') return { url: globalThis.__intentProduction?.unhookedSession ? new URL('../public/portal/embedded-wallet/sdk-provider.mjs', import.meta.url).href : servedProviderUrl, shortCircuit: true };
  return next(specifier, context);
} });
const durableClaims = new Map();
globalThis.indexedDB = { open() {
  const request = {};
  queueMicrotask(() => { request.result = { transaction() {
    const tx = { objectStore: () => ({add(value, key) {queueMicrotask(() => { if (durableClaims.has(key)) { tx.error = new Error('ConstraintError'); tx.onabort(); } else {durableClaims.set(key, value); tx.oncomplete();} });}, put(value, key) {queueMicrotask(() => {durableClaims.set(key, value); tx.oncomplete();});}}) }; return tx;
  } }; request.onsuccess(); }); return request;
} };
const start = await import('../public/portal-intent/start.mjs');
const wallet = await gatedWallet();
const p = await withListingHash(fixturePurchase({ address: wallet.address }));
const now = Date.now(); const view = viewFor(p, { now });
Object.assign(view.start, { listing: p.listing, agreement: { generatedAt: now }, identity: { bundle: identityFor(p, wallet.address, now).bundle } });
const intent = await buildIntent({ view, start: view.start, wallet: wallet.address, now });
let approve; let signed = 0;
globalThis.__intentProduction = { factory(args) {
  const fn = args.approve;
  approve = fn; globalThis.__intentProduction.args = args;
  return { isLocked: () => false, getPublicAccount: () => ({address: wallet.address}), request: async ({params}) => {
    if (await fn({ method: 'sign', address: wallet.address, message: params[0] })) { signed++; return {success: true, data: { signature: 'signature' }}; }
    return { success: false };
  } };
} };
async function session(dialog = () => true, options = {}) {
  await start.openEmbeddedWallet({}, options);
  return globalThis.__intentProduction.options.sessionFactory({ approve: dialog });
}
function api(path) {
  if (path.endsWith('/start')) return { ...view, start: { ...view.start, needs: { identitySignature: true } } };
  throw new Error('stop after identity');
}
test('production start.mjs wraps the session approval seam and refuses arbitrary bytes', async () => {
  let dialogs = 0; await session(() => {dialogs++; return true;});
  assert.equal(start.covers({ provider: {isDacsEmbeddedWallet: true, isLocked: () => false}, terms: p.terms }), true);
  assert.equal(start.covers({ provider: {isLocked: () => false}, terms: p.terms }), false);
  // During the real Start dialog, arbitrary signature requests must be fenced
  // after acceptance; run() uses the real flow, not a copy in a test helper.
  await assert.rejects(start.run({ id: p.id, token: 'token', address: wallet.address, api, log() {} }), /stop after identity/);
  assert.equal(signed, 1); assert.equal(dialogs, 1);
  assert.equal(await approve({ method: 'sign', message: 'normal after Start', address: wallet.address }), true);
  assert.equal(dialogs, 2);
});
for (const event of ['lock', 'new session']) {
  test(`production ${event} invalidates a pending Start dialog`, async () => {
    let resolve; let began; const opened = new Promise(r => {began = r;});
    await session(() => {began(); return new Promise(r => {resolve = r;});});
    const before = signed;
    const pending = start.run({ id: p.id, token: 'token', address: wallet.address, api, log() {} });
    const rejected = assert.rejects(pending, e => e.code === 'intent_mismatch'); await opened;
    if (event === 'lock') globalThis.__intentProduction.options.onPublicState({locked: true});
    else await session();
    resolve(true); await rejected; assert.equal(signed, before);
  });
}
test('production reload under the same Start record cannot ask the SDK for the identity signature again', async () => {
  await session(); const before = signed;
  await assert.rejects(start.run({ id: p.id, token: 'token', address: wallet.address, api, log() {} }), e => e.code === 'intent_mismatch' && e.field === 'journal');
  assert.equal(signed, before);
});
test('production reload with a new Start record signs the identity again, once', async () => {
  await session(); const before = signed;
  const renewed = (path) => {
    if (path.endsWith('/start')) return { ...view, start: { ...view.start, intent: { ...view.start.intent, id: 'rec_bbbbbbbbbbbbbbbbbbbbbb' }, needs: { identitySignature: true } } };
    throw new Error('stop after identity');
  };
  await assert.rejects(start.run({ id: p.id, token: 'token', address: wallet.address, api: renewed, log() {} }), /stop after identity/);
  assert.equal(signed, before + 1);
});
test('production keeps the per-step dialogs when durable storage is unavailable', async () => {
  const saved = globalThis.indexedDB; globalThis.indexedDB = undefined;
  let fresh;
  try { fresh = await import('../public/portal-intent/start.mjs?no-durable-storage'); } finally { globalThis.indexedDB = saved; }
  await fresh.openEmbeddedWallet({}, {});
  await globalThis.__intentProduction.options.sessionFactory({ approve: () => true });
  assert.equal(fresh.covers({ provider: {isDacsEmbeddedWallet: true, isLocked: () => false}, terms: p.terms }), false);
});
test('production builds each session from its gate\'s fenced SDK class; a bridge without the hook keeps the per-step dialogs', async () => {
  const provider = {isDacsEmbeddedWallet: true, isLocked: () => false};
  await session();
  const Fenced = globalThis.__intentProduction.DemosCtor;
  assert.equal(typeof Fenced, 'function', 'start.mjs passed fenceSdk to the bridge');
  assert.deepEqual(await new Fenced().signMessage('outside a CREATE'), { type: 'ed25519', data: 'outside a CREATE' });
  assert.equal(start.covers({ provider, terms: p.terms }), true);
  globalThis.__intentProduction.unhooked = true;
  try {
    await session();
    assert.equal(globalThis.__intentProduction.DemosCtor, null);
    assert.equal(start.covers({ provider, terms: p.terms }), false);
  } finally {
    delete globalThis.__intentProduction.unhooked;
  }
  await session();
  assert.equal(start.covers({ provider, terms: p.terms }), true);
});
test('production gives each session the anchor journal behind the gate fence', async () => {
  const calls = [];
  const anchorJournal = { get: async (k) => { calls.push(['get', k]); }, put: async (k) => { calls.push(['put', k]); }, withWalletLock: async (k, work) => { calls.push(['lock', k]); return work(); } };
  await session(() => true, { anchorJournal });
  const given = globalThis.__intentProduction.args.anchorJournal;
  assert.notEqual(given, anchorJournal);
  await given.withWalletLock('lane', async () => { await given.get('lane'); await given.put('lane', {}); });
  assert.deepEqual(calls, [['lock', 'lane'], ['get', 'lane'], ['put', 'lane']], 'with no covered write pending it forwards unchanged');
  await session(() => true, {});
  assert.equal(globalThis.__intentProduction.args.anchorJournal, undefined);
});
test('production stops an approved CREATE after a lock with the SDK session\'s own error, so the wallet reports superseded', async () => {
  const dp = await withListingHash(fixturePurchase({ address: wallet.address, now, devnet: true }));
  const dview = viewFor(dp, { now, recordId: 'rec_cccccccccccccccccccccc' });
  const unsigned = identityFor(dp, wallet.address, now);
  dview.start.identity = { bundle: unsigned.bundle };
  const intent = await buildIntent({ view: dview, start: dview.start, wallet: wallet.address, now });
  const saved = globalThis.__intentProduction.factory;
  // The session signs for real, so the gate can check the Agreement draft.
  globalThis.__intentProduction.factory = (args) => {
    globalThis.__intentProduction.args = args;
    return { isLocked: () => false, getPublicAccount: () => ({address: wallet.address}), request: async ({params}) => {
      if (!await args.approve({ method: 'sign', address: wallet.address, message: params[0] })) return { success: false };
      return wallet.session.request({ method: 'sign', params });
    } };
  };
  try {
    await session(() => true, { anchorJournal: { get: async () => undefined, put: async () => assert.fail('the stopped CREATE was recorded as issued'), withWalletLock: (k, work) => work() } });
    const { approve: gated, anchorJournal: fenced } = globalThis.__intentProduction.args;
    let planned; let stopped;
    const dapi = (path, body) => {
      if (path.endsWith('/start')) return { ...dview, start: { ...dview.start, needs: { identitySignature: true } } };
      if (path.endsWith('/plan')) {
        planned = planAgreement({ jobId: dp.jobId, listing: dp.listing, buyerBundle: attachIdentityPresentation(unsigned, body.signature), generatedAt: now });
        return { plan: { needs: { agreementSignature: false }, draft: planned.draft } };
      }
      if (path.endsWith('/sign')) return { evidence: { protocol: { stage: 'agreement-signing' } } };
      throw new Error(`unexpected ${path}`);
    };
    const broker = { authenticate: async () => {}, approveOne: async () => {
      assert.equal(await gated({ method: 'sendTransaction', address: wallet.address, content: {
        kind: DEVNET_CREATE_KIND, artifactKind: 'Agreement', jobId: dp.jobId, logicalAddress: `dacs3:agreement:${dp.jobId}`, owner: intent.buyer, wallet: wallet.address,
        contentHash: planned.plan.agreementHash, exactStorageBytes: JSON.stringify(planned.draft), network: intent.network.name, chainIdentity: intent.network.chainIdentity, nonce: 1, debit: { totalOs: '1' },
      } }), true);
      globalThis.__intentProduction.options.onPublicState({locked: true});
      stopped = await fenced.put('lane', { stage: 'broadcast-started' }).then(() => null, (error) => error);
      return { state: 'denied' };
    } };
    await assert.rejects(start.run({ id: dp.id, token: 'token', address: wallet.address, api: dapi, broker, provider: {}, log() {} }), (e) => e.code === 'intent_mismatch' && e.field === 'superseded');
    assert.ok(stopped instanceof EmbeddedWalletError && stopped.code === 'superseded' && /^Nothing was sent:/.test(stopped.message), String(stopped?.stack ?? stopped));
  } finally {
    globalThis.__intentProduction.factory = saved;
  }
});
// Test process needs no browser resources after this file.
test.after(() => { hooks.deregister(); wallet.session.lock(); delete globalThis.__intentProduction; });

test('production devnet Start requires the session source-phase marker; an unhooked session keeps per-step approvals', async () => {
  const devnet = await withListingHash(fixturePurchase({ address: wallet.address, devnet: true }));
  const provider = { isDacsEmbeddedWallet: true, isLocked: () => false };
  try {
    for (const unhookedSession of [false, true, false]) {
      globalThis.__intentProduction.unhookedSession = unhookedSession;
      await session();
      assert.equal(start.covers({ provider, terms: devnet.terms }), !unhookedSession, 'devnet requires the marker from this session module');
      assert.equal(start.covers({ provider, terms: p.terms }), true, 'the fixture profile needs no source phase fence');
    }
  } finally { delete globalThis.__intentProduction.unhookedSession; }
});
