// Showcase 12 through the built-in live-testnet operator: the operator passes
// DACS_SHOWCASE_WALKTHROUGH into the app config it builds, and once the seller
// is attached and the operator listens, its public origin serves the pages and
// reports the live purchase setup; a bad switch value is refused before
// anything opens; and a composition whose protocol cannot prepare the live
// purchase, or that is not built for it, reports none. Uses the loopback Node2
// fixture; nothing is bought. Also pins two properties the showcase relies on:
// the operator reads the switch before its first await; and prepare_purchase's
// live default protocol follows devnetLivePurchase alone, never the showcase's
// stricter signal.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { createMcpServerFactory } from '../src/mcp/server.mjs';
import { OFFLINE_AGREEMENT_MODE } from '../src/dacs/protocol-purchases.mjs';
import { createDevnetDemoComposition } from '../src/devnet-demo/composition.mjs';
import { createDevnetDemoOperator } from '../src/devnet-demo/operator.mjs';
import { bootstrapTestWalletCustody } from '../src/devnet-demo/operator-custody.mjs';
import { admitObservedNode2Identity, observeNode2Identity } from '../src/devnet-demo/operator-network.mjs';
import { startOperatorNode2 } from './helpers/devnet-operator-node2.mjs';

const freePort = () => new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });

async function operatorConfig(t, node2, label) {
  const root = await mkdtemp(join(tmpdir(), `showcase-live-operator-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ports = await Promise.all([freePort(), freePort(), freePort()]);
  const config = {
    format: 'dacs-node2-demo-operator/v1', authority: 'TEST-RUN-showcase-operator-001', publicOrigin: `http://127.0.0.1:${ports[0]}`, sellerOrigin: `https://127.0.0.1:${ports[1]}`,
    sellerTls: { keyPath: join(root, 'seller-key.pem'), certificatePath: join(root, 'seller-cert.pem') }, directoryOrigin: `http://127.0.0.1:${ports[2]}`,
    stateDirectory: join(root, 'state'), custodyDirectory: join(root, 'custody'), networkAdmissionPath: join(root, 'admission.json'),
    listing: { listingId: 'showcase-operator-report', listingVersion: 1, displayName: 'Showcase Operator Seller', title: 'Showcase report', description: 'Seller bytes for the showcase test.', category: 'services.market-report', tags: ['report'], priceDem: '1', validForMs: 86400000, deadlineSecAfterCommit: 3600 },
    sellerFeeBudget: { maxTotalOs: '10000000000' }, buyerFeeBudget: { maxTotalOs: '12000000000' }, content: { mediaType: 'text/plain; charset=utf-8', text: 'Purchased bytes for the showcase test.' },
  };
  await bootstrapTestWalletCustody({ directory: config.custodyDirectory, publicOrigin: config.publicOrigin });
  const observation = await observeNode2Identity({ endpoint: node2.endpoint, network: 'demos-devnet', fetchImpl: node2.fetchImpl });
  const admission = admitObservedNode2Identity({ observation, authority: config.authority, transportAuthority: 'TEST-owned-showcase-node2', pinVersion: 'TEST-showcase-pin-v1', reviewedChainIdentity: observation.chainIdentity });
  await writeFile(config.networkAdmissionPath, `${JSON.stringify(admission)}\n`, { mode: 0o600 });
  await writeFile(config.sellerTls.keyPath, node2.key, { mode: 0o600 });
  await writeFile(config.sellerTls.certificatePath, node2.cert, { mode: 0o600 });
  const configPath = join(root, 'operator.json');
  await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  const testFetch = (url, options) => new URL(url).protocol === 'https:' ? node2.fetchImpl(url, options) : fetch(url, options);
  return { config, configPath, testFetch };
}

async function createOperator(t, { configPath, testFetch }, mode) {
  const previous = process.env.DACS_SHOWCASE_WALKTHROUGH;
  if (mode === undefined) delete process.env.DACS_SHOWCASE_WALKTHROUGH; else process.env.DACS_SHOWCASE_WALKTHROUGH = mode;
  try {
    const operator = await createDevnetDemoOperator({ configPath, fetchImpl: testFetch, authorizeSellerApproval: () => true });
    t.after(() => operator.close());
    return operator;
  } finally {
    if (previous === undefined) delete process.env.DACS_SHOWCASE_WALKTHROUGH; else process.env.DACS_SHOWCASE_WALKTHROUGH = previous;
  }
}

async function operatorFor(t, node2, mode) {
  const setup = await operatorConfig(t, node2, mode ?? 'unset');
  return { operator: await createOperator(t, setup, mode), testFetch: setup.testFetch };
}

async function startShowcase(t, origin, inspect = async () => {}) {
  const client = new Client({ name: 'dacs-test', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
  t.after(() => client.close());
  await inspect(client);
  const result = await client.callTool({ name: 'start_showcase', arguments: {} });
  assert.notEqual(result.isError, true);
  return result.structuredContent;
}

test('the built-in operator passes the showcase switch into its app config, default off, and refuses other values', { timeout: 120000 }, async (t) => {
  const node2 = await startOperatorNode2();
  t.after(() => node2.close());
  for (const [mode, expected] of [[undefined, 'off'], ['off', 'off'], ['on', 'on']]) {
    const { operator } = await operatorFor(t, node2, mode);
    assert.equal((await operator.prepareDevnetDemo()).config.showcaseWalkthrough, expected, String(mode));
  }
  // An empty or differently spelled value is refused, never read as off, and
  // before anything opens: no state directory and nothing on the public origin.
  for (const mode of ['', 'ON', 'true']) {
    const setup = await operatorConfig(t, node2, 'refused');
    await assert.rejects(createOperator(t, setup, mode), /DACS_SHOWCASE_WALKTHROUGH must be off or on/, JSON.stringify(mode));
    await assert.rejects(stat(setup.config.stateDirectory), { code: 'ENOENT' }, JSON.stringify(mode));
    await assert.rejects(fetch(`${setup.config.publicOrigin}/portal/showcase/`), /fetch failed/, `${JSON.stringify(mode)}: the public origin must not be listening`);
  }
  // The switch is checked before the config is read: a bad switch wins over a
  // missing or malformed config file.
  const setup = await operatorConfig(t, node2, 'precedence');
  const malformed = `${setup.configPath}.malformed`;
  await writeFile(malformed, '{', { mode: 0o600 });
  for (const configPath of [`${setup.configPath}.missing`, malformed]) {
    await assert.rejects(createOperator(t, { ...setup, configPath }, 'ON'), /DACS_SHOWCASE_WALKTHROUGH must be off or on/, configPath);
    await assert.rejects(createOperator(t, { ...setup, configPath }, 'on'), (error) => !/DACS_SHOWCASE_WALKTHROUGH/.test(error.message), `${configPath} with a valid switch fails on the config`);
  }
});

test('the operator reads the showcase switch before its first await', { timeout: 150000 }, async (t) => {
  const node2 = await startOperatorNode2();
  t.after(() => node2.close());
  const previous = process.env.DACS_SHOWCASE_WALKTHROUGH;
  const set = (mode) => { if (mode === undefined) delete process.env.DACS_SHOWCASE_WALKTHROUGH; else process.env.DACS_SHOWCASE_WALKTHROUGH = mode; };
  t.after(() => set(previous));
  // The switch is read before the operator's first await, so a value set right
  // after the call changes nothing later, including the app config. (Another
  // synchronous read before that await would see the same value, so the
  // property is the snapshot's timing, not the number of reads.)
  for (const [atCall, later, expected] of [['on', 'off', 'on'], ['off', 'on', 'off'], [undefined, 'on', 'off'], ['on', 'ON', 'on']]) {
    const { configPath, testFetch } = await operatorConfig(t, node2, 'once');
    set(atCall);
    const pending = createDevnetDemoOperator({ configPath, fetchImpl: testFetch, authorizeSellerApproval: () => true });
    set(later);
    const operator = await pending.finally(() => set(previous));
    t.after(() => operator.close());
    assert.equal((await operator.prepareDevnetDemo()).config.showcaseWalkthrough, expected, `${atCall} then ${later}`);
  }
  // A bad value at the call is refused even if a good one follows.
  const { configPath, testFetch } = await operatorConfig(t, node2, 'once-refused');
  set('ON');
  const pending = createDevnetDemoOperator({ configPath, fetchImpl: testFetch, authorizeSellerApproval: () => true });
  set('on');
  await assert.rejects(pending.finally(() => set(previous)), /DACS_SHOWCASE_WALKTHROUGH must be off or on/);
});

// The an earlier review reason for keeping the protocol check out of devnetLivePurchase:
// that flag alone gives prepare_purchase its live default protocol. Pinned at
// the factory with a capturing purchases.prepare stub.
test('prepare_purchase defaults to the live protocol on devnetLivePurchase alone, whatever the showcase reports', async (t) => {
  const config = loadConfig({ DACS_PUBLIC_ORIGIN: 'https://plugin.example', DACS_AUTH_MODE: 'external', DACS_OAUTH_ISSUER: 'https://issuer.example', DACS_DATABASE_PATH: ':memory:', DACS_SHOWCASE_WALKTHROUGH: 'on' });
  const ctx = { http: { authInfo: { scopes: ['dacs.purchases.write'], extra: { issuer: 'https://issuer.example', subject: 'TEST-buyer' } } } };
  const args = { listingId: 'showcase-operator-report', version: 1, seller: `did:demos:agent:${'a'.repeat(64)}`, idempotencyKey: 'TEST-showcase-default-protocol' };
  for (const [devnetLivePurchase, showcaseLivePurchase] of [[true, true], [true, false], [false, false], [false, true]]) {
    const label = JSON.stringify({ devnetLivePurchase, showcaseLivePurchase });
    const prepared = [];
    const purchases = { prepare: async (input) => { prepared.push(input); throw new Error('TEST stop after capture'); } };
    const server = createMcpServerFactory({ config, services: { purchases, accounts: { resolveFromToken: () => ({ id: 'acct_TEST' }) } }, logger: { info() {}, error() {} }, devnetLivePurchase, showcaseLivePurchase })();
    t.after(() => server.close());
    const tool = server._registeredTools.prepare_purchase;
    for (const protocol of [undefined, 'dacs-pay-dem', OFFLINE_AGREEMENT_MODE]) assert.equal((await tool.handler({ ...args, ...(protocol ? { protocol } : {}) }, ctx)).isError, true, label);
    assert.equal(prepared.length, 3, label);
    assert.equal(prepared[0].accountId, 'acct_TEST', label);
    // Omitted: the live default only when devnetLivePurchase is true; otherwise no protocol at all.
    assert.equal('protocol' in prepared[0], devnetLivePurchase, label);
    assert.equal(prepared[0].protocol, devnetLivePurchase ? OFFLINE_AGREEMENT_MODE : undefined, label);
    // Explicit: passed through unchanged either way.
    assert.equal(prepared[1].protocol, 'dacs-pay-dem', label);
    assert.equal(prepared[2].protocol, OFFLINE_AGREEMENT_MODE, label);
  }
});

test('a running built-in operator serves the pages and reports the live purchase setup', { timeout: 150000 }, async (t) => {
  const node2 = await startOperatorNode2();
  t.after(() => node2.close());
  const { operator, testFetch } = await operatorFor(t, node2, 'on');
  const prepared = await operator.prepareDevnetDemo();
  const composition = await createDevnetDemoComposition(prepared.composition);
  t.after(() => composition.sellerAgent.close?.());
  const application = await createApp({ config: prepared.config, dacsProtocol: composition.dacsProtocol, devnetAgreementTransport: prepared.devnetAgreementTransport, fetchImpl: testFetch });
  t.after(() => application.close());
  const origin = prepared.config.publicOrigin;
  // Before the seller is attached and the operator listens, the public origin
  // does not serve the app at all.
  assert.notEqual((await fetch(`${origin}/portal/showcase/`)).status, 200);
  // The same lifecycle as scripts/devnet-demo-compose.mjs; no buyer driver.
  await operator.attachSellerAgent({ sellerAgent: composition.sellerAgent, application, composition });
  const running = await operator.listen({ application, composition });
  t.after(() => running.close());
  assert.equal((await fetch(`${origin}/portal/showcase/`)).status, 200);
  assert.equal(application.services.protocol.supportsMode(OFFLINE_AGREEMENT_MODE), true);
  const showcase = await startShowcase(t, origin);
  assert.equal(showcase.livePurchaseComposed, true);
  const [walk, live] = showcase.choices;
  assert.equal(walk.url, `${origin}/portal/showcase/`);
  assert.equal(live.realTransactions, true);
  assert.deepEqual(live.startWith, ['search_agents', 'get_listing', 'prepare_purchase']);
  assert.match(live.note, /controls whether its seller is running and which accounts may buy/);
  assert.match(live.note, /cannot tell whether this user can buy/);
});

// the source change: the shipped live-testnet operator honours DACS_SHOWCASE_REPORT_VIEW
// through loadConfig, as it does the other switches it forwards; default off.
test('the built-in operator passes the report view setting into its app config, default off, and serves the report view when it is 1', { timeout: 150000 }, async (t) => {
  const node2 = await startOperatorNode2();
  t.after(() => node2.close());
  const previous = process.env.DACS_SHOWCASE_REPORT_VIEW;
  const set = (value) => { if (value === undefined) delete process.env.DACS_SHOWCASE_REPORT_VIEW; else process.env.DACS_SHOWCASE_REPORT_VIEW = value; };
  t.after(() => set(previous));
  const operators = {};
  for (const [value, expected] of [[undefined, false], ['0', false], ['1', true]]) {
    set(value);
    const { operator, testFetch } = await operatorFor(t, node2, 'on');
    set(previous);
    const prepared = await operator.prepareDevnetDemo();
    assert.equal(prepared.config.showcaseReportView, expected, String(value));
    operators[String(value)] = { operator, prepared, testFetch };
  }
  // Running with 1: the portal shell is marked and the purchase tools name the report App.
  const { operator, prepared, testFetch } = operators['1'];
  const composition = await createDevnetDemoComposition(prepared.composition);
  t.after(() => composition.sellerAgent.close?.());
  const application = await createApp({ config: prepared.config, dacsProtocol: composition.dacsProtocol, devnetAgreementTransport: prepared.devnetAgreementTransport, fetchImpl: testFetch });
  t.after(() => application.close());
  await operator.attachSellerAgent({ sellerAgent: composition.sellerAgent, application, composition });
  const running = await operator.listen({ application, composition });
  t.after(() => running.close());
  const origin = prepared.config.publicOrigin;
  assert.match(await (await fetch(`${origin}/portal/link`)).text(), /<body data-showcase-report-view="1">/);
  await startShowcase(t, origin, async (client) => {
    const { tools } = await client.listTools();
    for (const name of ['prepare_purchase', 'get_purchase_status', 'verify_deal']) {
      assert.equal(tools.find((tool) => tool.name === name)._meta.ui.resourceUri, 'ui://dacs/status-report-v2.html', name);
    }
  });
});

// The real composition with one capability removed, so each half of
// showcaseLivePurchase is needed: without the seller endpoint resolver every
// native capability is present but the protocol cannot prepare; without native
// DEM delivery the protocol can prepare but the app is not built for the live
// purchase (devnetLivePurchase is false).
const LIVE_DESCRIPTION = /^Use this when the user wants to buy a verified fixed-price DACS listing with DEM on the Demos testnet\. Uses protocol "dacs-sr2-wallet-agreement"/;
for (const [removed, preparable] of [['sellerEndpoint', false], ['nativeDemDelivery', true]]) {
  test(`an operator composition without ${removed} reports no live purchase`, { timeout: 150000 }, async (t) => {
    const node2 = await startOperatorNode2();
    t.after(() => node2.close());
    const { operator, testFetch } = await operatorFor(t, node2, 'on');
    const prepared = await operator.prepareDevnetDemo();
    const composition = await createDevnetDemoComposition(prepared.composition);
    t.after(() => composition.sellerAgent.close?.());
    const { [removed]: dropped, ...partial } = composition.dacsProtocol;
    assert.ok(dropped, removed);
    const application = await createApp({ config: prepared.config, dacsProtocol: partial, devnetAgreementTransport: prepared.devnetAgreementTransport, fetchImpl: testFetch });
    t.after(() => application.close());
    assert.equal(application.services.protocol.supportsMode(OFFLINE_AGREEMENT_MODE), preparable);
    await operator.attachSellerAgent({ sellerAgent: composition.sellerAgent, application, composition });
    const running = await operator.listen({ application, composition });
    t.after(() => running.close());
    const showcase = await startShowcase(t, prepared.config.publicOrigin, async (client) => {
      // Only the showcase tool applies the protocol check: without the resolver,
      // prepare_purchase keeps its live description; without delivery it has none.
      const { tools } = await client.listTools();
      const description = tools.find((tool) => tool.name === 'prepare_purchase').description;
      if (preparable) assert.doesNotMatch(description, LIVE_DESCRIPTION); else assert.match(description, LIVE_DESCRIPTION);
    });
    assert.equal(showcase.livePurchaseComposed, false);
    const live = showcase.choices.find((c) => c.id === 'live-testnet-purchase');
    assert.equal(live.realTransactions, false);
    assert.equal(live.note, 'Live testnet purchases are not set up on this server.');
  });
}
