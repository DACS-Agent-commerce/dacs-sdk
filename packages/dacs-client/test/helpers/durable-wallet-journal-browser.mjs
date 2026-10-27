// Role-owned copy of test/browser/dacs-offline-browser-broker.browser.test.mjs
// setup/reachCreate with the harness browserAgreement journal supplied by the
// caller (the durable journal). Existing packaged Playwright launch only:
// the executable named by DACS_TEST_CHROME, loopback-only routing.
import assert from 'node:assert/strict';
import { startProtocolHarness, addSeller } from '../dacs-loopback-fixture.test.mjs';
import { startAgreementChain } from './offline-agreement-fixture.mjs';
import { tool, linkedUser } from './flows.mjs';
import { launchTestChrome, openRecordedPage, createCleanupStack, freshPassword, uiCreate, uiUnlock, UI } from './embedded-wallet-fixtures.mjs';
import { contentHash } from '@kynesyslabs/dacs';

export async function durableBrowserSetup(t, journal) {
  const cleanup = createCleanupStack(); t.after(() => cleanup.run());
  const chain = await startAgreementChain();
  const h = await startProtocolHarness({ chain, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' }, browserAgreement: { journal } });
  cleanup.add('loopback harness', 10000, () => h.close());
  const launched = await launchTestChrome(cleanup); // Missing Chrome FAILS, never skipped acceptance.
  t.diagnostic(`browser-real Chrome ${launched.version}; ${launched.executablePath}; no injected walletFactory`);
  const rec = await openRecordedPage(launched.browser, cleanup), { page } = rec;
  await page.route('**/*', (route) => new URL(route.request().url()).origin === h.origin ? route.continue() : route.abort());
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
  const seller = await addSeller(h, { listingId: `durable-browser-${Date.now()}` });
  const p = await tool(h, user, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, walletAddress: address,
    idempotencyKey: `durable-browser-${Date.now()}`, protocol: 'dacs-sr2-wallet-agreement' });
  assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
  await page.goto(p.approvalUrl);
  await page.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
  assert.equal(await uiUnlock(wallet, password), address);
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor();
  return { ...rec, h, chain, user, p, address, password, launched, verify: () => tool(h, user, 'verify_deal', { operationId: p.operationId }) };
}

export async function durableReachCreate(w) {
  await w.page.locator('#dacs-sign-agreement').click();
  const dialog = w.page.getByRole('dialog');
  await dialog.waitFor();
  await dialog.getByRole('button', { name: UI.approve }).click(); // identity presentation
  await dialog.getByLabel('Exact content to approve').waitFor();
  await dialog.getByRole('button', { name: UI.approve }).click(); // Agreement bytes
  await dialog.getByText('purpose: offline-agreement-browser-session', { exact: false }).waitFor();
  await dialog.getByRole('button', { name: UI.approve }).click(); // fresh broker authentication
  await dialog.getByLabel('Exact content to approve').waitFor();
  const shown = JSON.parse(await dialog.getByLabel('Exact content to approve').textContent());
  assert.equal(shown.kind, 'dacs-storage-anchor-create'); assert.equal(shown.wallet, w.address);
  assert.equal(shown.contentHash, contentHash(JSON.parse(shown.exactStorageBytes)));
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
  return { dialog, shown };
}
