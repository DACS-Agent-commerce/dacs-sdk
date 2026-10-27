// Real local Chrome + packaged signer + trusted approval dialog + unchanged
// retry-safe relay + independent simulated SDK-wire fixture. No real node,
// funds, ChatGPT installation, source-blind acceptance or security review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../helpers/harness.mjs';
import { startAnchorFixture, anchorRequest, memoryAnchorJournal } from '../helpers/dacs-storage-anchor-wallet-fixture.mjs';
import { chromeSkipReason, launchTestChrome, openRecordedPage, createCleanupStack } from '../helpers/embedded-wallet-fixtures.mjs';
import { startAgreementChain } from '../helpers/offline-agreement-fixture.mjs';
import { createDemosSr2Adapter } from '../../src/dacs/demos-sr2-adapter.mjs';
import { canonicalize, contentHash, createFixedPriceAgreementSignatureContribution, finalizeFixedPriceAgreementContributions, generateCanonicalJobId, isPayeeBoundAgreementDocument } from '@kynesyslabs/dacs';
import { buildUnsignedIdentityBundle, attachIdentityPresentation } from '../../src/dacs/listing.mjs';
import { planAgreement } from '../../src/dacs/purchase-protocol.mjs';
import { canonicalSignature } from '../../src/dacs/fixture-anchors.mjs';
import { addressForClaim, verifyDemosSignature } from '../../src/wallet/demos-signature.mjs';
import { createEphemeralWallet } from '../fixtures/wallet.mjs';
import { fixtureListing } from '../fixtures/listings.mjs';

test('anchor approval displays exact artifact and total debit; synthetic click cannot approve; trusted approval signs and broadcasts once', { skip: chromeSkipReason() }, async (t) => {
  const cleanup = createCleanupStack();
  t.after(() => cleanup.run());
  const chain = await startAnchorFixture();
  const h = await startHarness({ chain, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
  cleanup.add('anchor harness', 10000, () => h.close());
  const launched = await launchTestChrome(cleanup);
  t.diagnostic(`Chrome ${launched.version}; ${launched.executablePath}`);
  const { page, requests, consoleErrors } = await openRecordedPage(launched.browser, cleanup);
  // The page may request only the local plugin; no external source/endpoint.
  await page.route('**/*', (route) => new URL(route.request().url()).origin === h.origin ? route.continue() : route.abort());
  const response = await page.goto(`${h.origin}/portal/assets/embedded-wallet/index.html`);
  assert.equal(response.status(), 200);
  const base = `${h.origin}/portal/assets/embedded-wallet`;
  const account = await page.evaluate(async ({ base, network, rpcUrl }) => {
    const { Demos, validateMnemonic } = await import(`${base}/demos-runtime.mjs`);
    const { createSdkWalletSession } = await import(`${base}/sdk-provider.mjs`);
    const { createApprovalController } = await import(`${base}/approval.mjs`);
    const controller = createApprovalController(document.body);
    const rows = new Map();
    // Explicit test-only RAM journal: source-aware browser adapter, not a
    // production persistence claim. No mnemonic leaves the page.
    const journal = { get: (k) => structuredClone(rows.get(k)), put: (k, v) => rows.set(k, structuredClone(v)), withWalletLock: (_k, work) => work() };
    window.__anchorWallet = createSdkWalletSession({ DemosCtor: Demos, validateMnemonic, anchorJournal: journal, approve: controller.approve,
      transactionTransport: { profile: 'simulated-loopback', network, rpcUrl } });
    window.__anchorController = controller;
    return window.__anchorWallet.create();
  }, { base, network: h.config.chain.network, rpcUrl: `${h.origin}/portal/api/wallet-rpc` });
  const request = anchorRequest(account.address, account.network);
  await page.evaluate((r) => {
    window.__anchorResult = null;
    window.__anchorWallet.request({ method: 'sendTransaction', params: [r] }).then((out) => { window.__anchorResult = out; });
  }, request);
  const dialog = page.getByRole('dialog', { name: 'Approval needed' });
  await dialog.waitFor();
  const exact = await dialog.getByLabel('Exact content to approve').textContent();
  const shown = JSON.parse(exact);
  for (const k of ['owner', 'logicalAddress', 'artifactKind', 'jobId', 'contentHash', 'envelopeHash', 'network']) assert.equal(shown[k], request[k]);
  assert.equal(shown.storageAddress, request.transaction.content.to);
  assert.equal(shown.programName, request.transaction.content.data[1].programName);
  assert.deepEqual(JSON.parse(shown.exactStorageBytes), request.transaction.content.data[1].data);
  assert.deepEqual(JSON.parse(shown.exactCreate), request.transaction.content.data[1]);
  assert.equal(shown.debit.totalDem, '7');
  assert.equal(shown.debit.totalOs, '7000000000');
  assert.equal(chain.record.confirms.length, 0, 'no transaction signed/submitted before deliberate approval');
  const accept = dialog.getByRole('button', { name: 'Approve', exact: true });
  await accept.evaluate((button) => button.click());
  assert.equal(await page.evaluate(() => window.__anchorController.pending), true, 'untrusted scripted click cannot approve');
  assert.equal(await page.evaluate(() => window.__anchorResult), null);
  assert.equal(chain.record.broadcastAttempts.length, 0);
  await accept.click();
  await page.waitForFunction(() => window.__anchorResult !== null, null, { timeout: 15000 });
  const out = await page.evaluate(() => window.__anchorResult);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.deepEqual(chain.record.broadcastAttempts, [out.data.hash]);
  assert.equal(chain.record.accepted[0].signature.type, 'ed25519');
  assert.equal(chain.record.accepted[0].content.data[1].metadata.contentHash, request.contentHash);
  assert.equal(chain.record.accepted[0].content.data[1].metadata.envelopeHash, request.envelopeHash);
  // Rejecting a fresh, otherwise-valid coordinate cannot issue another send.
  const second = anchorRequest(account.address, account.network, { nonce: 2, logicalAddress: 'dacs3:agreement:second-offline-job' });
  await page.evaluate((r) => {
    window.__anchorResult = null;
    window.__anchorWallet.request({ method: 'sendTransaction', params: [r] }).then((out) => { window.__anchorResult = out; });
  }, second);
  await page.getByRole('dialog', { name: 'Approval needed' }).getByRole('button', { name: 'Reject', exact: true }).click();
  await page.waitForFunction(() => window.__anchorResult !== null);
  assert.equal((await page.evaluate(() => window.__anchorResult)).error.code, 'user_rejected');
  assert.equal(chain.record.broadcastAttempts.length, 1);
  await page.evaluate(() => { window.__anchorWallet.lock(); window.__anchorController.cancel(); });
  assert.ok(requests.every((r) => new URL(r.url).origin === h.origin), 'page stays on local plugin origin');
  assert.deepEqual(consoleErrors, []);
});

// This exercises the new normative kind in a real browser through the
// already-existing wallet request seam. It is NOT a new portal/server broker
// or a claim that the full MCP profile is browser-accessible in this build.
test('real Chrome approves the unchanged SDK two-party Agreement and exact CREATE kind/debit; native readback authenticates it', { skip: chromeSkipReason() }, async (t) => {
  const cleanup = createCleanupStack();
  t.after(() => cleanup.run());
  const chain = await startAgreementChain();
  const h = await startHarness({ chain, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
  cleanup.add('Agreement harness', 10000, () => h.close());
  const launched = await launchTestChrome(cleanup);
  t.diagnostic(`Chrome ${launched.version}; ${launched.executablePath}`);
  const { page, requests, consoleErrors } = await openRecordedPage(launched.browser, cleanup);
  await page.route('**/*', (route) => new URL(route.request().url()).origin === h.origin ? route.continue() : route.abort());
  await page.goto(`${h.origin}/portal/assets/embedded-wallet/index.html`);
  const account = await page.evaluate(async ({ base, network, rpcUrl }) => {
    const { Demos, validateMnemonic } = await import(`${base}/demos-runtime.mjs`);
    const { createSdkWalletSession } = await import(`${base}/sdk-provider.mjs`);
    const { createApprovalController } = await import(`${base}/approval.mjs`);
    const controller = createApprovalController(document.body);
    const rows = new Map();
    window.__anchorJournalRows = rows; // fresh test-owned public approval/transaction records only
    const journal = { get: (k) => structuredClone(rows.get(k)), put: (k, v) => rows.set(k, structuredClone(v)), withWalletLock: (_k, work) => work() };
    window.__anchorWallet = createSdkWalletSession({ DemosCtor: Demos, validateMnemonic, anchorJournal: journal, approve: controller.approve,
      transactionTransport: { profile: 'simulated-loopback', network, rpcUrl } });
    window.__anchorController = controller;
    return window.__anchorWallet.create();
  }, { base: `${h.origin}/portal/assets/embedded-wallet`, network: h.config.chain.network, rpcUrl: `${h.origin}/portal/api/wallet-rpc` });
  async function browserSign(message) {
    await page.evaluate((m) => {
      window.__anchorResult = null;
      window.__anchorWallet.request({ method: 'sign', params: [m] }).then((out) => { window.__anchorResult = out; });
    }, message);
    const dialog = page.getByRole('dialog', { name: 'Approval needed' });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.waitForFunction(() => window.__anchorResult !== null);
    const answer = await page.evaluate(() => window.__anchorResult);
    assert.equal(answer.success, true);
    return canonicalSignature(answer.data.signature);
  }
  const seller = createEphemeralWallet();
  const timestamp = 1791144000000;
  const unsigned = buildUnsignedIdentityBundle({ address: account.address, presentedAt: timestamp, sessionSeed: 'browser-actual-agreement' });
  const bundle = attachIdentityPresentation(unsigned, await browserSign(unsigned.message));
  const planned = planAgreement({ jobId: generateCanonicalJobId({ timestamp }), listing: fixtureListing(seller, { now: timestamp }), buyerBundle: bundle, generatedAt: timestamp });
  const buyerSignature = await browserSign(planned.agreementMessage);
  const buyer = await createFixedPriceAgreementSignatureContribution(planned.plan, 'buyer', { party: bundle.presentedBy, algorithm: 'ed25519', sign: (bytes) => {
    assert.equal(Buffer.from(bytes).toString('utf8'), planned.agreementMessage);
    return buyerSignature;
  } });
  const sellerContribution = await createFixedPriceAgreementSignatureContribution(planned.plan, 'seller', { party: seller.claim, algorithm: 'ed25519', sign: seller.signBytes });
  const artifact = await finalizeFixedPriceAgreementContributions(planned.plan, [buyer, sellerContribution], (s) =>
    verifyDemosSignature({ address: addressForClaim(s.party), message: Buffer.from(s.signedBytes).toString('utf8'), signature: s.value }) ? 'valid' : 'invalid');
  assert.equal(isPayeeBoundAgreementDocument(artifact), true);
  assert.equal(Object.hasOwn(artifact, 'artifactType'), false);
  const request = anchorRequest(account.address, account.network, { artifact, artifactKind: 'Agreement', logicalAddress: planned.anchorAddress });
  request.transaction.content.from_ed25519_address = account.address;
  const memory = memoryAnchorJournal();
  const reader = createDemosSr2Adapter({ rpcUrl: chain.url, now: () => timestamp, journal: {
    get: memory.get, put: (record) => memory.put(record.planId, record), records: () => memory.snapshot().map(([, value]) => value), withWalletLock: memory.withWalletLock,
  } });
  const logicalPlan = await reader.planWrite({ logicalAddress: planned.anchorAddress, artifact, writer: request.owner, artifactKind: 'Agreement', receiptContentHash: request.contentHash });
  const handoff = await reader.takeStorageAnchorHandoff({ planId: logicalPlan.planId, walletAddress: account.address, network: account.network });
  assert.equal(canonicalize(handoff.unsignedTransaction.content), canonicalize(request.transaction.content), 'independent fixture request matches retained exact handoff');
  const badArtifact = structuredClone(artifact);
  const signature = badArtifact.signatures[0];
  signature.value = `${signature.value[0] === 'A' ? 'B' : 'A'}${signature.value.slice(1)}`;
  const badRequest = anchorRequest(account.address, account.network, { artifact: badArtifact, artifactKind: 'Agreement', logicalAddress: planned.anchorAddress });
  const bad = await page.evaluate((r) => window.__anchorWallet.request({ method: 'sendTransaction', params: [r] }), badRequest);
  assert.equal(bad.success, false);
  assert.equal(bad.error.code, 'invalid_params');
  assert.equal(chain.wire.record.broadcastAttempts.length, 0);
  await page.evaluate((r) => {
    window.__anchorResult = null;
    window.__anchorWallet.request({ method: 'sendTransaction', params: [r] }).then((out) => { window.__anchorResult = out; });
  }, request);
  const dialog = page.getByRole('dialog', { name: 'Approval needed' });
  await dialog.waitFor();
  const shown = JSON.parse(await dialog.getByLabel('Exact content to approve').textContent());
  assert.equal(shown.artifactKind, 'Agreement');
  assert.equal(shown.exactStorageBytes, canonicalize(artifact));
  assert.equal(JSON.parse(shown.exactCreate).metadata.artifactKind, 'Agreement');
  assert.equal(shown.contentHash, contentHash(artifact));
  assert.equal(shown.jobId, artifact.jobId);
  assert.equal(shown.logicalAddress, planned.anchorAddress);
  assert.equal(shown.debit.totalOs, '7000000000');
  const approve = dialog.getByRole('button', { name: 'Approve', exact: true });
  await approve.evaluate((button) => button.click());
  assert.equal(await page.evaluate(() => window.__anchorController.pending), true);
  assert.equal(chain.wire.record.confirms.length, 0);
  assert.equal(chain.wire.record.broadcastAttempts.length, 0);
  await approve.click();
  await page.waitForFunction(() => window.__anchorResult !== null, null, { timeout: 15000 });
  const answer = await page.evaluate(() => window.__anchorResult);
  assert.equal(answer.success, true, JSON.stringify(answer));
  assert.equal(chain.wire.record.broadcastAttempts.length, 1);
  assert.equal(canonicalize(chain.wire.record.accepted[0].content.data[1].data), canonicalize(artifact));
  // The public signed envelope is retained by the browser wallet, not
  // reconstructed from RPC. This does not transfer a key or add a broker.
  const records = await page.evaluate(() => [...window.__anchorJournalRows.values()]);
  assert.equal(records.length, 1);
  assert.equal(records[0].hash, answer.data.hash);
  await reader.adoptWalletAuthorization({ planId: logicalPlan.planId, walletRecord: records[0] });
  const readback = await reader.read(planned.anchorAddress, { expectedWriter: request.owner, expectedArtifactKind: 'Agreement' });
  assert.equal(readback.status, 'present');
  assert.equal(canonicalize(readback.artifact), canonicalize(artifact));
  assert.equal(await reader.verifyReceipt({ receipt: readback.receipt, logicalAddress: planned.anchorAddress, artifact, expectedWriter: request.owner, artifactKind: 'Agreement' }), 'valid');
  await page.evaluate(() => { window.__anchorWallet.lock(); window.__anchorController.cancel(); });
  assert.ok(requests.every((r) => new URL(r.url).origin === h.origin));
  assert.deepEqual(consoleErrors, []);
});
