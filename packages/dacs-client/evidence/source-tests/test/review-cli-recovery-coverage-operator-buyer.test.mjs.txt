// Exact-current coverage of the actual operator buyer driver
// (src/devnet-demo/operator-buyer.mjs): six normal vs twelve resume bounded
// verify_deal polls, retained-payment report/advance, issued-payment recovery
// holds and no resend/new approval/Agreement CREATE. The actual module runs in
// a VM; MCP/OAuth, portal HTTP, wallet, broker and buyer native readback are
// inert scripted seams (the fulfilment-id cases use the actual native
// purchased-report reader over a scripted seller anchor). NODE-only offline:
// no socket, RPC, TLS or chain. The scripted delivery readback is fixture
// data, never live delivery evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import * as nodeCrypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { canonicalize, contentHash } from '@kynesyslabs/dacs';
import { checkSellerSessionDelegation } from '../public/portal/seller-session-delegation.mjs';
import * as sellerContent from '../src/mcp/seller-content.mjs';
import { createDevnetDemoDeliveryCapability, readDevnetPurchasedReport as realRead } from '../src/devnet-demo/native-delivery.mjs';
import { DEVNET_PURCHASED_REPORT_KIND } from '../src/devnet-demo/deliverable.mjs';

const { sellerContentForModel, SELLER_DATA_MAX } = sellerContent;
const ACCEPTED = Symbol('TEST 202');

if (!vm.SourceTextModule) {
  test('actual operator buyer driver bounded-poll/resume cases (flagged child)', () => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', '--test', '--test-reporter=tap', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 120000, env });
    assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, /# fail 0/); assert.match(child.stdout, /# skipped 0/);
    const pass = /# pass (\d+)/.exec(child.stdout)?.[1]; assert.ok(Number(pass) >= 10, `child pass count ${pass}`);
  });
} else {
  const source = await readFile(new URL('../src/devnet-demo/operator-buyer.mjs', import.meta.url), 'utf8');
  const json = (value) => JSON.parse(JSON.stringify(value));
  const bridge = (fn) => (value) => fn(JSON.parse(JSON.stringify(value)));
  const origin = 'http://127.0.0.1:10001';
  const address = `0x${'a'.repeat(64)}`, buyer = `did:demos:agent:${'a'.repeat(64)}`, seller = `did:demos:agent:${'b'.repeat(64)}`, payee = `0x${'b'.repeat(64)}`;
  const network = 'demos-devnet', chainIdentity = 'c'.repeat(64), HASH = '1f'.repeat(32), RECOVERED = '2e'.repeat(32), AGREEMENT = 'e'.repeat(64), FULFILMENT = '3d'.repeat(32);
  const listing = { listingId: 'cli-recovery', listingVersion: 1, seller: { identity: { presentedBy: seller } }, pricing: { kind: 'fixed', price: { amount: '1', currency: 'DEM' } } };
  const listingContentHash = contentHash(listing), operationId = 'op-TEST', jobId = 'job-TEST';
  const binding = { bindingId: 'd'.repeat(64), chainIdentity, endpoint: 'https://source.invalid/', network, pinVersion: 'TEST-pin', transportAuthority: 'TEST-authority' };
  const payload = { content: { type: 'native', from: address, to: payee, amount: '1000000000', data: ['native', { nativeOperation: 'send', args: [payee, '1000000000'] }], nonce: 7, timestamp: 1791259000000 }, signature: null, hash: '' };
  const report = { reportVersion: '1', jobId, agreementHash: AGREEMENT, settlementId: 'TEST-settlement', body: ['TEST fixture report'] };
  // The bytes the actual purchased-report reader accepts for this job, Agreement, Listing, payment and seller.
  const purchased = { reportVersion: '1', kind: DEVNET_PURCHASED_REPORT_KIND, jobId, agreementHash: AGREEMENT, listing: { contentHash: listingContentHash, listingId: listing.listingId, version: 1 },
    title: 'TEST purchased report', settlementId: `demos:${HASH}`, producer: seller, content: { mediaType: 'text/plain; charset=utf-8', text: 'TEST fixture purchased report' } };

  // `nativeRead` binds the buyer readback to the actual reader over a seller anchor retaining `artifact` bound to `fid`;
  // readyAt 0 means the app purchase is already delivery-ready.
  async function harness({ fid = FULFILMENT, artifact = report, nativeRead = false, readyAt = Infinity, record = null, recover, statusChange = () => {}, reportChange = () => {}, fulfilmentChange = () => {}, delegation = null, planInProgress = 0, planFails = false, views = null } = {}) {
    const fx = { sends: 0, signs: [], expects: [], creates: 0, verifyDeal: 0, portal: [], reports: [], saved: [], readbacks: 0, readbackInputs: [], readbackResults: [], toolFulfilmentIds: [], anchorReads: 0 };
    const sellerBinding = { version: '1', profile: 'dacs-native-delivery-publication/v1', jobId, phase: 'deliver-storage-program', phaseIndex: 2, listing: { listingId: listing.listingId, version: 1, contentHash: listingContentHash },
      agreementHash: AGREEMENT, fulfilmentId: fid, purchaseAmount: { amount: '1', currency: 'DEM' }, payloadHash: contentHash(artifact) };
    const receipt = { writer: seller, transactionRef: { kind: 'demos-tx', value: 'TEST' }, blockRef: { id: 'TEST', height: '1', timestamp: 1 }, contentHash: contentHash(artifact) };
    const anchor = { authority: 'TEST-reader', writer: seller, publish: async () => ({}), read: async () => ({}), verifyReceipt: async () => 'invalid',
      readRetained: async () => { fx.anchorReads++; return { status: 'present', deliveryBinding: json(sellerBinding), artifact: json(artifact), receipt: json(receipt) }; } };
    const nativeCapability = createDevnetDemoDeliveryCapability({ authority: 'TEST-reader', anchor });
    const store = new Map(record ? [[record.idempotencyKey, json(record)]] : []);
    const protocolAt = (stage) => ({ jobId, stage, agreement: { hash: AGREEMENT } });
    const ready = () => { const value=sellerContentForModel({protocol:{ ...protocolAt('delivery-ready'), layers:{service:'test-report-delivered-and-verified'}, nativeEvidence: { deliveryReadback: { disposition: 'present' } }, delivery: { status:'delivery-ready', report: artifact, deliverableRef:{anchor:{locator:'TEST-deliverable'},contentHash:contentHash(artifact)}, fulfilmentId: fid, payloadHash: contentHash(artifact) } }}).protocol; reportChange(value.delivery.report); fulfilmentChange(value.delivery); fx.toolFulfilmentIds.push(typeof value.delivery.fulfilmentId); return value; };
    let committed = Boolean(record), ready_ = readyAt <= 0;
    const status = () => { const value = { operationId, terms: { buyerWallet: address, seller, listingContentHash }, protocol: ready_ ? ready() : protocolAt('payment-observed') }; statusChange(value); return value; };
    const tools = {
      prepare_purchase: () => ({ created: true, status: 'agreement_pending', operationId, approvalUrl: `${origin}/portal/purchase/${operationId}#t=TEST-handoff-token`, protocol: { stage: 'identity', jobId }, terms: { buyerWallet: address, seller, listingContentHash, amountOs: '1000000000', payee } }),
      verify_deal: () => {
        if (!committed) { committed = true; return { status: 'awaiting_approval', protocol: protocolAt('seller-committed') }; }
        fx.verifyDeal++; if (fx.verifyDeal >= readyAt) ready_ = true;
        return { status: ready_ ? 'delivered' : 'payment_observed', protocol: ready_ ? ready() : protocolAt('payment-observed') };
      },
      get_purchase_status: () => status(),
    };
    const portal = {
      [`/portal/authorize/TESTUID/api/challenge`]: () => ({ message: 'TEST login challenge', challengeId: 'login-1' }),
      [`/portal/authorize/TESTUID/api/complete`]: () => ({ redirectTo: `${origin}/operator/oauth/callback?code=TEST-code&iss=TEST-iss` }),
      [`/portal/api/purchase/${operationId}/agreement/identity`]: () => ({ signRequest: { message: 'TEST identity', ...(delegation?{delegation}:{}) } }),
      // planInProgress: that many 202 answers (the server's plan step is still running) before the plan is saved.
      [`/portal/api/purchase/${operationId}/agreement/plan`]: (body) => { (fx.planBodies ??= []).push(Object.keys(body).sort()); (fx.planSignatures ??= []).push(body.signature ?? null); if (body.signature !== undefined && planInProgress > 0) { planInProgress--; return { [ACCEPTED]: true, error: 'plan_in_progress', message: 'TEST plan step still running' }; }
        return { signRequest: { agreementHash: AGREEMENT, agreementMessage: 'TEST agreement', summary: { listing: { contentHash: listingContentHash }, payee, amountOs: '1000000000' } } }; },
      // views: the purchase views read while the plan step runs, in order (the last repeats).
      [`/portal/api/purchase/${operationId}/view`]: () => views ? (fx.views = (fx.views ?? 0) + 1, views[Math.min(fx.views, views.length) - 1]) : ({ status: 'agreement_pending', evidence: { protocol: planFails ? { stage: 'identity', lastAttempt: { at: 'TEST-at', step: 'agreement-context', outcome: 'indeterminate', reason: 'TEST writer failure' } } : { stage: 'agreement-signing' } } }),
      [`/portal/api/purchase/${operationId}/agreement/sign`]: () => ({ evidence: { protocol: { stage: 'agreement-signing' } } }),
      [`/portal/api/purchase/${operationId}/challenge`]: () => ({ message: 'TEST payment terms', challengeId: 'pay-1' }),
      [`/portal/api/purchase/${operationId}/approve`]: () => ({ status: 'payment_handoff', payload: json(payload) }),
      [`/portal/api/purchase/${operationId}/report`]: (body) => { fx.reports.push(body); return { evidence: { protocol: protocolAt('payment-observed') } }; },
    };
    const fetchImpl = async (url, init = {}) => {
      const path = new URL(url).pathname; fx.portal.push(path);
      if (path === '/portal/authorize/TESTUID' && !init.method) return new Response('', { status: 200 });
      const handler = portal[path]; if (!handler) throw new Error(`TEST unscripted fetch ${path}`);
      const answer = handler(JSON.parse(init.body ?? '{}')), accepted = answer?.[ACCEPTED] === true;
      return new Response(JSON.stringify(answer), { status: accepted ? 202 : 200, headers: { 'content-type': 'application/json' } });
    };
    class Client { async connect() {} async close() {} async callTool({ name, arguments: args }) { const tool = tools[name]; if (!tool) throw new Error(`TEST unscripted tool ${name}`); return { structuredContent: json(tool(args)) }; } }
    const mocks = {
      'node:crypto': nodeCrypto,
      '../../public/portal/seller-session-delegation.mjs': { checkSellerSessionDelegation: (request,terms)=>checkSellerSessionDelegation(json(request),json(terms)) },
      '@modelcontextprotocol/client': { Client, StreamableHTTPClientTransport: class {}, auth: async (provider, options) => { if (options.authorizationCode) return 'AUTHORIZED'; provider.redirectToAuthorization(new URL(`${origin}/portal/authorize/TESTUID`)); return 'REDIRECT'; } },
      '@kynesyslabs/dacs': { canonicalize: bridge(canonicalize), contentHash: bridge(contentHash) },
      '../../public/portal/offline-agreement-broker.mjs': { createOfflineAgreementBrokerClient: () => ({ anchorJournal: {}, authenticate: async ({ sign }) => { await sign('TEST broker'); }, approveOne: async () => { fx.creates++; return { state: 'completed' }; }, useNativePaymentLane() {} }) },
      '../dacs/purchase-protocol.mjs': { listingPin: () => ({ listingId: listing.listingId, version: 1, contentHash: listingContentHash }), protocolSupport: () => ({ phases: { delivery: 2 } }) },
      '../mcp/seller-content.mjs': { sellerContentForModel: bridge(sellerContentForModel), decodeSellerDataEnvelope: bridge(sellerContent.decodeSellerDataEnvelope) },
      './native-delivery.mjs': { readDevnetPurchasedReport: async (_capability, input) => { fx.readbacks++; fx.readbackInputs.push(json(input));
        if (nativeRead) { const read = json(await realRead(nativeCapability, input)); fx.readbackResults.push(read); return read; }
        return { status: 'present', artifact: json(report), receipt: { writer: seller, transactionRef: { kind: 'demos-tx', value: 'TEST' }, blockRef: { id: 'TEST', height: '1', timestamp: 1 }, contentHash: 'TEST' } }; } },
    };
    const context = vm.createContext({ URL, URLSearchParams, Buffer, setTimeout }), module = new vm.SourceTextModule(source, { context, identifier: 'actual-operator-buyer.mjs' });
    await module.link((specifier) => { assert.ok(Object.hasOwn(mocks, specifier), `unmocked ${specifier}`); const values = mocks[specifier], names = Object.keys(values); return new vm.SyntheticModule(names, function () { for (const name of names) this.setExport(name, values[name]); }, { context }); });
    await module.evaluate();
    const wallet = { getPublicAccount: () => ({ address }), request: async ({ method, params }) => {
      if (method === 'sign') { fx.signs.push(params[0]); return { success: true, data: { signature: 'TEST-signature' } }; }
      if (method === 'sendTransaction') { fx.sends++; return { success: true, data: { hash: HASH } }; }
      throw new Error(`TEST wallet method ${method}`);
    } };
    const runStore = { read: async (key) => (store.has(key) ? json(store.get(key)) : null), save: async (value) => { store.set(value.idempotencyKey, json(value)); fx.saved.push(value.stage); return { record: json(value), receipt: { limits: 'TEST' } }; },
      receipt: async () => ({ limits: 'TEST' }), runKey: (key) => `run-${key}` };
    const composition = { listing, nativeDemDelivery: {}, sellerAgent: { deliveryStateOf: () => null }, contextProvider: { invocations: [] } };
    const driver = module.namespace.createOperatorBuyerDriver({ publicOrigin: origin, fetchImpl, wallet, buyer, seller, network, chainIdentity, paymentTransportBinding: binding,
      approval: { expect: (value) => fx.expects.push(value.kind) }, attachJournal: () => () => {}, composition, runStore,
      ...(recover ? { recoverIssuedPayment: async (input) => { fx.recoverCalls = (fx.recoverCalls ?? 0) + 1; fx.recoverInput = json(input); return recover(input); } } : {}) });
    return { driver, fx, store };
  }
  const retainedRecord = (more = {}) => ({ idempotencyKey: 'TEST-key', stage: 'payment-issued', operationId, jobId, token: 'TEST-handoff-token', approvalOffset: 0, agreementHash: AGREEMENT,
    terms: { amountOs: '1000000000', payee }, payment: { transactionHash: HASH, amountOs: '1000000000', payee, network, chainIdentity }, ...more });
  const intent = { format: 'dacs-node2-operator-native-payment-intent/v1', payer: address, payee, amountOs: '1000000000', nonce: 7, timestamp: 1791259000000, data: payload.content.data, payloadHash: 'f'.repeat(64), dataHash: 'f'.repeat(64), network, chainIdentity, sourceBinding: binding };
  const noNewEffects = (fx) => { assert.equal(fx.sends, 0, 'no payment resend'); assert.equal(fx.creates, 0, 'no Agreement CREATE'); assert.deepEqual(json(fx.expects), ['oauth-wallet-login'], 'only the wallet-login approval'); };

  test('headless buyer refuses an overlong delegation before signing identity or delegation', async () => {
    const now=Date.now(),payload={version:'1',kind:'seller-session-delegation',buyer,seller,sessionPublicKey:'9'.repeat(64),listingPin:{listingId:listing.listingId,version:1,contentHash:listingContentHash},jobId,notBefore:now,expiresAt:now+86400001};
    const {driver,fx}=await harness({delegation:{payload,message:`dacs-chatgpt-plugin:seller-session-delegation:v1:${canonicalize(payload)}`}});
    await assert.rejects(driver.purchase({idempotencyKey:'TEST-key'}),/longer than 24 hours/);
    assert.deepEqual(json(fx.signs),['TEST login challenge']);assert.equal(fx.sends,0);assert.equal(fx.creates,0);
  });
  test('normal purchase: exactly six bounded verify_deal polls after the report, one send, one Agreement CREATE', async () => {
    const { driver, fx } = await harness();
    const error = await driver.purchase({ idempotencyKey: 'TEST-key' }).then(() => null, (e) => e);
    assert.match(String(error?.message), /did not reach authenticated native delivery-ready readback/);
    const progression = JSON.parse(/"progression":(\[[^\]]*\])/.exec(error.message)[1]);
    assert.equal(fx.verifyDeal, 6); assert.deepEqual(progression, Array(6).fill('payment-observed'));
    assert.equal(fx.sends, 1); assert.equal(fx.creates, 1); assert.equal(fx.reports.length, 1); assert.equal(fx.reports[0].txHash, HASH);
    assert.deepEqual(json(fx.expects), ['oauth-wallet-login', 'agreement-identity', 'broker-authentication', 'agreement-signature', 'agreement-create', 'payment-terms', 'native-payment']);
    assert.ok(fx.saved.includes('payment-issued'));
  });
  test('a plan step still running answers 202: the driver reads the purchase until its plan is saved, then continues; nothing is signed twice', async () => {
    const { driver, fx } = await harness({ planInProgress: 1 });
    const error = await driver.purchase({ idempotencyKey: 'TEST-key' }).then(() => null, (e) => e);
    assert.match(String(error?.message), /did not reach authenticated native delivery-ready readback/);
    const plan = `/portal/api/purchase/${operationId}/agreement/plan`, view = `/portal/api/purchase/${operationId}/view`, at = fx.portal.indexOf(plan);
    assert.deepEqual(fx.portal.slice(at, at + 3), [plan, view, plan]);
    assert.deepEqual(json(fx.planBodies), [['signature', 'token'], ['token']], 'the saved plan is read without a signature');
    assert.equal(fx.signs.filter((message) => message === 'TEST identity').length, 1);
    assert.equal(fx.sends, 1); assert.equal(fx.creates, 1);
  });
  test('a plan step lost to a server restart (no step running, still at identity) is asked for again with the same retained signatures, once per poll', async () => {
    const identityView = { status: 'agreement_pending', evidence: { protocol: { stage: 'identity' } } };
    const { driver, fx } = await harness({ planInProgress: 2, views: [{ ...identityView, planRunning: true }, identityView, identityView] });
    const error = await driver.purchase({ idempotencyKey: 'TEST-key' }).then(() => null, (e) => e);
    assert.match(String(error?.message), /did not reach authenticated native delivery-ready readback/);
    const plan = `/portal/api/purchase/${operationId}/agreement/plan`, view = `/portal/api/purchase/${operationId}/view`, at = fx.portal.indexOf(plan);
    // A running step is only read; a lost one is asked for again after each read.
    assert.deepEqual(fx.portal.slice(at, at + 6), [plan, view, view, plan, view, plan]);
    assert.equal(fx.planSignatures.length, 3); assert.ok(fx.planSignatures.every((signature) => signature === fx.planSignatures[0]), 'the same retained signature every time');
    assert.equal(fx.signs.filter((message) => message === 'TEST identity').length, 1, 'nothing signed again');
    assert.equal(fx.creates, 1);
  });
  test('a plan step lost to a restart is not asked for again once the purchase expired', async () => {
    const { driver, fx } = await harness({ planInProgress: 1, views: [{ status: 'expired', evidence: { protocol: { stage: 'identity' } } }] });
    await assert.rejects(driver.purchase({ idempotencyKey: 'TEST-key' }), /the purchase is expired; no Agreement was planned/);
    assert.equal(fx.planSignatures.length, 1); assert.equal(fx.sends, 0); assert.equal(fx.creates, 0);
  });
  test('a plan step still running that then records a failure ends the run with its note; nothing is signed again', async () => {
    const { driver, fx } = await harness({ planInProgress: 1, planFails: true });
    await assert.rejects(driver.purchase({ idempotencyKey: 'TEST-key' }), /the Agreement plan step failed: TEST writer failure/);
    assert.deepEqual(json(fx.planBodies), [['signature', 'token']]);
    assert.equal(fx.signs.filter((message) => message === 'TEST identity').length, 1);
    assert.equal(fx.sends, 0); assert.equal(fx.creates, 0);
  });
  test('normal purchase reaching delivery-ready within six polls finishes through the actual finish path', async () => {
    const { driver, fx } = await harness({ readyAt: 6 });
    const result = json(await driver.purchase({ idempotencyKey: 'TEST-key' }));
    assert.equal(result.status, 'delivery-ready'); assert.equal(fx.verifyDeal, 6); assert.equal(result.progression.length, 6); assert.equal(fx.readbacks, 1);
    assert.deepEqual(result.report, report, 'operator output retains the independently verified original bytes');
    assert.equal(fx.readbackInputs[0].settlementId, `demos:${HASH}`);
    // The 64-hex fulfilmentId stays raw in the tool result, so the driver binds its readback to it.
    assert.equal(fx.readbackInputs[0].fulfilmentId, FULFILMENT); assert.equal(fx.readbackInputs[0].deliveryBinding.fulfilmentId, FULFILMENT);
  });
  test('operator refuses labelled MCP report bytes that differ from independent native readback', async () => {
    const { driver, fx } = await harness({ readyAt: 1, reportChange: (wrapper) => { wrapper.text = wrapper.text.replace('TEST fixture report', 'unverified seller instructions'); } });
    await assert.rejects(driver.purchase({ idempotencyKey: 'TEST-key' }), /independent buyer native readback differs/);
    assert.equal(fx.sends, 1); assert.equal(fx.creates, 1); assert.equal(fx.readbacks, 1);
  });
  test('operator refuses an altered wrapper on its final read-only status check', async () => {
    const { driver, fx } = await harness({ readyAt: 1, statusChange: (value) => { if (value.protocol.delivery) value.protocol.delivery.report.label = 'trusted instructions'; } });
    await assert.rejects(driver.purchase({ idempotencyKey: 'TEST-key' }), /read-only purchase status lost/);
    assert.equal(fx.sends, 1); assert.equal(fx.creates, 1); assert.equal(fx.readbacks, 1);
  });
  test('resume with retained hash: report once then exactly twelve bounded polls; no resend/new approval/Agreement CREATE', async () => {
    const { driver, fx } = await harness({ record: retainedRecord() });
    const error = await driver.resume({ idempotencyKey: 'TEST-key' }).then(() => null, (e) => e);
    const progression = JSON.parse(/"progression":(\[[^\]]*\])/.exec(error.message)[1]);
    assert.equal(fx.verifyDeal, 12); assert.deepEqual(progression, ['retained-payment-report', ...Array(12).fill('payment-observed')]);
    assert.equal(fx.reports.length, 1); assert.equal(fx.reports[0].txHash, HASH); assert.equal(fx.reports[0].token, 'TEST-handoff-token'); noNewEffects(fx);
  });
  test('resume reaching delivery-ready at poll nine (beyond the normal six) recovers within the twelve-poll bound', async () => {
    const { driver, fx } = await harness({ record: retainedRecord(), readyAt: 9 });
    const result = json(await driver.resume({ idempotencyKey: 'TEST-key' }));
    assert.equal(result.status, 'delivery-ready'); assert.equal(fx.verifyDeal, 9); assert.deepEqual(result.progression, ['retained-payment-report', ...Array(8).fill('payment-observed'), 'delivery-ready']);
    assert.equal(result.payment.transactionHash, HASH); noNewEffects(fx);
  });
  test('resume without hash recovers the original issued payment then reports it; recovery stage is retained', async () => {
    const record = retainedRecord({ stage: 'payment-handoff', payment: undefined, paymentIntent: intent });
    const { driver, fx, store } = await harness({ record, readyAt: 1, recover: () => ({ status: 'recovered', transactionHash: RECOVERED, approvalHash: 'a'.repeat(64), readback: { disposition: 'included' } }) });
    const result = json(await driver.resume({ idempotencyKey: 'TEST-key' }));
    assert.equal(result.status, 'delivery-ready'); assert.equal(fx.recoverCalls, 1); assert.equal(fx.reports[0].txHash, RECOVERED);
    assert.equal(fx.readbackInputs[0].settlementId, `demos:${RECOVERED}`);
    assert.equal(fx.recoverInput.intent.payloadHash, intent.payloadHash); assert.ok(fx.saved.includes('payment-recovered'));
    assert.equal(store.get('TEST-key').paymentRecovery.recoveredAtStage, 'resume-before-report'); noNewEffects(fx);
  });
  const holds = {
    'recovery held (absent/ambiguous candidate)': { recover: () => ({ status: 'held', reason: 'TEST ambiguous issued candidates' }), reason: /TEST ambiguous/ },
    'recovery readback throws (indeterminate)': { recover: () => { throw Object.assign(new Error('x'), { code: 'TEST_UNAVAILABLE' }); }, reason: /readback is unavailable: TEST_UNAVAILABLE/ },
    'recovered with malformed hash': { recover: () => ({ status: 'recovered', transactionHash: 'not-a-hash' }), reason: /absent or ambiguous/ },
    'no recovery capability': { recover: null, reason: /no retained payment transaction hash/ },
  };
  for (const [label, { recover, reason }] of Object.entries(holds)) test(`resume HOLD: ${label}; no report, no resend, no new approval`, async () => {
    const record = retainedRecord({ stage: 'payment-handoff', payment: undefined, paymentIntent: intent });
    const { driver, fx, store } = await harness({ record, ...(recover ? { recover } : {}) });
    const result = json(await driver.resume({ idempotencyKey: 'TEST-key' }));
    assert.equal(result.status, 'held'); assert.equal(result.noResend, true); assert.match(result.reason, reason);
    assert.equal(fx.reports.length, 0); assert.equal(fx.verifyDeal, 0); assert.equal(store.get('TEST-key').stage, 'held'); noNewEffects(fx);
  });
  test('resume HOLD: retained hash without private handoff token never reports through a guessed capability', async () => {
    const { driver, fx } = await harness({ record: retainedRecord({ token: undefined }) });
    const result = json(await driver.resume({ idempotencyKey: 'TEST-key' }));
    assert.equal(result.status, 'held'); assert.match(result.reason, /private handoff capability is unavailable/); assert.equal(fx.reports.length, 0); noNewEffects(fx);
  });
  test('resume rejects a status with a changed Agreement or job before any report/recovery', async () => {
    for (const change of [(s) => { s.protocol.agreement.hash = '9'.repeat(64); }, (s) => { s.protocol.jobId = 'job-OTHER'; }, (s) => { s.terms.buyerWallet = payee; }]) {
      const { driver, fx } = await harness({ record: retainedRecord(), statusChange: change });
      await assert.rejects(driver.resume({ idempotencyKey: 'TEST-key' }), /retained purchase status/);
      assert.equal(fx.reports.length, 0); noNewEffects(fx);
    }
  });
  test('resume with no retained run holds without connecting', async () => {
    const { driver, fx } = await harness();
    const result = json(await driver.resume({ idempotencyKey: 'TEST-absent' }));
    assert.equal(result.status, 'held'); assert.equal(fx.portal.length, 0); assert.equal(fx.sends, 0);
  });

  // The tool result wraps a non-hex fulfilmentId as seller data; the native reader binds the seller's raw value.
  const NONHEX = 'fulfilment-1';
  const delivered = (fx, fid) => {
    assert.equal(fx.readbacks, 1); assert.equal(fx.anchorReads, 1, 'one read-only anchor read');
    assert.equal(fx.readbackInputs[0].fulfilmentId, fid); assert.equal(fx.readbackInputs[0].deliveryBinding.fulfilmentId, fid);
    assert.equal(fx.readbackResults[0].status, 'present');
  };
  for (const [label, fid, shown] of [['non-hex (wrapped)', NONHEX, 'object'], ['64-hex control (raw)', FULFILMENT, 'string']]) {
    test(`${label} fulfilmentId: the actual native reader binds the seller's value; the run is delivered and resume sends nothing`, async () => {
      const first = await harness({ fid, artifact: purchased, nativeRead: true, readyAt: 1 });
      const result = json(await first.driver.purchase({ idempotencyKey: 'TEST-key' }));
      assert.equal(result.status, 'delivery-ready'); assert.deepEqual(result.report, purchased);
      assert.ok(first.fx.toolFulfilmentIds.length > 0 && first.fx.toolFulfilmentIds.every((type) => type === shown), `the tool result shows it as ${shown}`);
      delivered(first.fx, fid);
      assert.equal(first.fx.sends, 1, 'one wallet send'); assert.equal(first.fx.creates, 1, 'one Agreement CREATE'); assert.equal(first.fx.reports.length, 1);
      const kept = first.store.get('TEST-key');
      assert.equal(kept.stage, 'delivery-ready'); assert.deepEqual(kept.decision, { outcome: 'delivered' }); assert.equal(kept.payment.transactionHash, HASH);
      const again = await harness({ fid, artifact: purchased, nativeRead: true, readyAt: 0, record: kept });
      assert.equal(json(await again.driver.resume({ idempotencyKey: 'TEST-key' })).status, 'delivery-ready');
      delivered(again.fx, fid); noNewEffects(again.fx); assert.equal(again.fx.reports.length, 0);
      assert.equal(again.store.get('TEST-key').stage, 'delivery-ready');
    });
  }
  test('a run left at payment-issued by a wrapped non-hex fulfilmentId resumes to delivery-ready with no resend', async () => {
    const { driver, fx, store } = await harness({ fid: NONHEX, artifact: purchased, nativeRead: true, readyAt: 0, record: retainedRecord() });
    const result = json(await driver.resume({ idempotencyKey: 'TEST-key' }));
    assert.equal(result.status, 'delivery-ready'); assert.equal(result.payment.transactionHash, HASH);
    delivered(fx, NONHEX); noNewEffects(fx); assert.equal(fx.reports.length, 0);
    assert.equal(store.get('TEST-key').stage, 'delivery-ready'); assert.equal(store.get('TEST-key').payment.transactionHash, HASH);
  });
  const long = 'f'.repeat(SELLER_DATA_MAX + 1);
  const unbindable = {
    'truncated envelope': { fid: long },
    // Byte-identical to a complete envelope of its 4096-unit prefix, which is longer than any binding allows.
    'truncated envelope marked complete': { fid: long, fulfilmentChange: (d) => { d.fulfilmentId.truncated = false; } },
    'complete envelope marked truncated': { fulfilmentChange: (d) => { d.fulfilmentId.truncated = true; }, fid: NONHEX },
    'forged label': { fid: NONHEX, fulfilmentChange: (d) => { d.fulfilmentId.label = 'Trusted plugin value.'; } },
    'raw delimiter in the text': { fid: 'a<b', fulfilmentChange: (d) => { d.fulfilmentId.text = d.fulfilmentId.text.replace('\\u003c', '<'); } },
    'extra key': { fid: NONHEX, fulfilmentChange: (d) => { d.fulfilmentId.verified = true; } },
    'not a string or an envelope': { fulfilmentChange: (d) => { d.fulfilmentId = 7; } },
    'raw value longer than any binding': { fulfilmentChange: (d) => { d.fulfilmentId = 'f'.repeat(129); } },
  };
  for (const [label, options] of Object.entries(unbindable)) test(`unbindable fulfilmentId (${label}): a recorded hold, never a readback with it, and resume holds again with no resend`, async () => {
    const first = await harness({ artifact: purchased, nativeRead: true, readyAt: 1, ...options });
    const result = json(await first.driver.purchase({ idempotencyKey: 'TEST-key' }));
    assert.equal(result.status, 'held'); assert.equal(result.noResend, true); assert.match(result.reason, /not a bindable string or a complete seller-data envelope of one/);
    assert.equal(first.fx.readbacks, 0); assert.equal(first.fx.sends, 1); assert.equal(first.fx.creates, 1);
    const kept = first.store.get('TEST-key');
    assert.equal(kept.stage, 'held'); assert.equal(kept.decision.outcome, 'held'); assert.equal(kept.payment.transactionHash, HASH);
    const again = await harness({ artifact: purchased, nativeRead: true, readyAt: 0, record: kept, ...options });
    const resumed = json(await again.driver.resume({ idempotencyKey: 'TEST-key' }));
    assert.equal(resumed.status, 'held'); assert.equal(resumed.reason, result.reason);
    assert.equal(again.fx.readbacks, 0); noNewEffects(again.fx); assert.equal(again.fx.reports.length, 0);
    assert.equal(again.store.get('TEST-key').stage, 'held'); assert.equal(again.store.get('TEST-key').payment.transactionHash, HASH);
  });
}
