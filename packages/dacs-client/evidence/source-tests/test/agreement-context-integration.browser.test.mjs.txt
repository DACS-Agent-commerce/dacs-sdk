// Actual portal UI in Chrome (DACS_TEST_CHROME only; missing Chrome FAILS),
// packaged embedded wallet with trusted clicks, real OAuth-authenticated MCP,
// the loopback HTTP broker, the operator Agreement context provider and the
// UNCHANGED read-only Demo context resolver/responder behind the plugin's
// loopback seller HTTP handler. All authority and chain state are ephemeral
// local simulations; payment, Vet, commitment and finality remain held.
import runTest from 'node:test';
const referenceSkip = process.env.DACS_SELLER_INTEROP_REFERENCE ? false : 'DACS_SELLER_INTEROP_REFERENCE is not set: seller reference cases not run';
const test = (name, options, fn) => typeof options === 'function'
  ? runTest(name, { skip: referenceSkip }, options)
  : runTest(name, { ...options, skip: referenceSkip }, fn);
import assert from 'node:assert/strict';
import { canonicalize, contentHash } from '@kynesyslabs/dacs';
import { startAgreementChain } from './helpers/offline-agreement-fixture.mjs';
import { tool, linkedUser, tokenFrom } from './helpers/flows.mjs';
import { memoryAnchorJournal } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';
import { startContextHarness, startDemoContextSeller, providerSlot, TEST_AUTHORITY } from './helpers/agreement-context-integration.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';
import { launchTestChrome, openRecordedPage, createCleanupStack, freshPassword, uiCreate, uiUnlock, UI, assertNoSecrets } from './helpers/embedded-wallet-fixtures.mjs';
import { vetNotPerformedRef } from '../src/dacs/purchase-protocol.mjs';

installLoopbackOnlyGuard();
let counter = 0;

async function setup(t) {
  const cleanup = createCleanupStack(); t.after(() => cleanup.run());
  const chain = await startAgreementChain();
  const memory = memoryAnchorJournal(), journal = { ...memory, entries: () => memory.snapshot() };
  const slot = providerSlot();
  const h = await startContextHarness({ chain, agreementContext: slot.config, browserAgreement: { journal } });
  cleanup.add('loopback harness', 10000, () => h.close());
  const launched = await launchTestChrome(cleanup);
  t.diagnostic(`browser-real Chrome ${launched.version}; ${launched.executablePath}; no injected walletFactory`);
  const rec = await openRecordedPage(launched.browser, cleanup), { page } = rec;
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === h.origin ? route.continue() : route.abort()));
  const user = await linkedUser(h);
  const link = await tool(h, user, 'start_wallet_link');
  await page.goto(link.linkUrl);
  await page.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
  const wallet = page.locator('#embedded-wallet'), password = freshPassword();
  const address = await uiCreate(wallet, password);
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor();
  await page.getByRole('button', { name: /^Sign and link/ }).click();
  await page.getByRole('dialog').getByText('purpose: link-wallet', { exact: false }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: UI.approve }).click();
  await page.getByRole('heading', { name: /^Wallet linked/ }).waitFor();
  const seller = await startDemoContextSeller(h, { listingId: `context-browser-${++counter}` });
  slot.install(seller);
  const p = await tool(h, user, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, walletAddress: address,
    idempotencyKey: `context-browser-${counter}`, protocol: 'dacs-sr2-wallet-agreement' });
  assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
  await page.goto(p.approvalUrl);
  await page.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
  assert.equal(await uiUnlock(wallet, password), address);
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor();
  const account = h.app.services.accounts.walletOwner(address);
  return { ...rec, h, chain, journal, user, seller, p, address, password,
    op: () => h.app.services.ops.get(account, p.operationId),
    verify: () => tool(h, user, 'verify_deal', { operationId: p.operationId }) };
}

test('Chrome: trusted wallet approvals sign the operator-context plan; unchanged Demo responder co-signs; one CREATE reads back agreement-anchored; payment held', { timeout: 120000 }, async (t) => {
  const w = await setup(t);
  await w.page.locator('#dacs-sign-agreement').click();
  const dialog = w.page.getByRole('dialog');
  await dialog.waitFor();
  await dialog.getByRole('button', { name: UI.approve }).click(); // identity presentation
  await dialog.getByLabel('Exact content to approve').waitFor();
  const agreementMessage = await dialog.getByLabel('Exact content to approve').textContent();
  const planned = w.op().state.protocol.planned, jobId = w.op().terms.protocol.jobId;
  assert.equal(agreementMessage, planned.agreementMessage, 'the wallet shows exactly the operator-context plan bytes');
  for (const party of planned.draft.parties) {
    assert.deepEqual(party.vetRecordRef, w.seller.vetRef(jobId, party.primaryClaim));
    assert.notEqual(party.vetRecordRef.contentHash, vetNotPerformedRef(jobId, party.primaryClaim).contentHash);
  }
  await dialog.getByRole('button', { name: UI.approve }).click(); // Agreement bytes
  await dialog.getByText('purpose: offline-agreement-browser-session', { exact: false }).waitFor();
  await dialog.getByRole('button', { name: UI.approve }).click(); // broker authentication
  await dialog.getByLabel('Exact content to approve').waitFor();
  const shown = JSON.parse(await dialog.getByLabel('Exact content to approve').textContent());
  assert.equal(shown.kind, 'dacs-storage-anchor-create'); assert.equal(shown.artifactKind, 'Agreement');
  assert.equal(shown.contentHash, planned.plan.agreementHash); assert.equal(shown.contentHash, contentHash(JSON.parse(shown.exactStorageBytes)));
  assert.equal(shown.debit.sellerAmountDem, '0');
  assert.deepEqual(w.seller.signed, [w.seller.wallet.claim], 'the Demo responder co-signed before any CREATE was shown');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
  const accept = dialog.getByRole('button', { name: UI.approve });
  await accept.evaluate((b) => b.click());
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0, 'guard witness: synthetic approval must not sign/broadcast');
  await accept.click();
  await w.page.locator('#flow').getByText(/Awaiting authenticated seller commitment and context/).waitFor({ timeout: 25000 });
  const verified = await w.verify();
  assert.equal(verified.protocol.stage, 'agreement-anchored', JSON.stringify(verified));
  const tx = w.chain.wire.record.accepted[0], artifact = tx.content.data[1].data;
  assert.equal(canonicalize(artifact), shown.exactStorageBytes); assert.equal(tx.content.from, w.address);
  assert.deepEqual(artifact.signatures.map((s) => s.party), [`did:demos:agent:${w.address.slice(2)}`, w.seller.wallet.claim]);
  assert.equal(verified.protocol.agreement.hash, planned.plan.agreementHash);
  assert.equal(verified.protocol.limits.payment, 'held'); assert.equal(verified.protocol.agreementContext.authority, TEST_AUTHORITY);
  assert.equal(verified.protocol.layers.dacsPurchase, 'not-evidenced'); assert.equal(verified.protocol.commitment, null);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1); assert.equal(w.chain.wire.record.accepted.length, 1);
  await w.page.locator('#dacs-recheck').click(); await w.verify();
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  assert.equal(await w.page.locator('#flow').getByRole('button', { name: /Approve.*purchase|Pay now/ }).count(), 0);
  const held = await fetch(`${w.h.origin}/portal/api/purchase/${w.p.operationId}/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: tokenFrom(w.p.approvalUrl), address: w.address }) }).then((r) => r.json());
  assert.equal(held.error, 'agreement_payment_held');
  assertNoSecrets(w.requests, [w.password], 'browser HTTP requests'); assertNoSecrets(w.h.logs, [w.password], 'server logs');
  assert.ok(w.requests.every((r) => new URL(r.url).origin === w.h.origin)); assert.deepEqual(w.consoleErrors, []);
  t.diagnostic(JSON.stringify({ stage: verified.protocol.stage, hash: shown.contentHash, nativeAddress: verified.protocol.agreement.nativeAddress, broadcastCount: 1, sellerSigned: 1, payment: 'held', authority: TEST_AUTHORITY }));
});

test('Chrome: missing operator context holds before any wallet Agreement signature', { timeout: 120000 }, async (t) => {
  const w = await setup(t);
  w.seller.faults.provider = async () => ({ disposition: 'indeterminate', reason: 'TEST authority unavailable' });
  await w.page.locator('#dacs-sign-agreement').click();
  const dialog = w.page.getByRole('dialog');
  await dialog.waitFor();
  await dialog.getByRole('button', { name: UI.approve }).click(); // identity presentation only
  await w.page.getByText(/operator Agreement context is indeterminate/).waitFor({ timeout: 15000 });
  assert.equal(w.op().state.protocol.planned, undefined); assert.equal(w.op().state.protocol.stage, 'identity');
  assert.equal(w.seller.received.length, 0); assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
  assertNoSecrets(w.requests, [w.password], 'held browser requests');
});

test('Node/browser harness never attempted an external connection', () => assert.deepEqual(externalAttempts, []));
