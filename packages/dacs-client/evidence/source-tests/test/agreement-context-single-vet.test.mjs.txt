// One Vet production per job in the devnet demo Agreement context provider
// (src/devnet-demo/agreement-context.mjs). From a live testnet purchase: the
// first plan request waited in the seller's approval prompt, a second plan
// request for the same purchase re-ran the buyer Vet with a new generatedAt,
// signed a different record, and the anchor refused it as a conflicting
// intent; the SDK reported only "submission outcome is indeterminate" and
// every retry failed the same way.
//
// Fixture chain only, no network (test/helpers/party-vet-fixture.mjs): the
// real anchor, listing publisher, packaged seller wallet and provider, with
// the party Vet state in its own store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCanonicalJobId, identityBundleHash } from '@kynesyslabs/dacs';
import { releaseDemDeliveryContext } from '../src/dacs/dem-delivery-context-consumer.mjs';
import { DEM_RAIL } from '../src/dacs/listing.mjs';
import { setupPartyVet as setup, sleep, within } from './helpers/party-vet-fixture.mjs';

// A presentation that never verifies: a character inside the signature is
// changed (the last base64url character carries only two bits, so changing
// it alone can leave the signature bytes as they were).
function badPresentation(bundle) {
  const copy = structuredClone(bundle), entry = copy.presentation.signatures[0];
  entry.signature = `${entry.signature.slice(0, 10)}${entry.signature[10] === 'A' ? 'B' : 'A'}${entry.signature.slice(11)}`;
  return copy;
}

// The same presenter with another presentation: the scope's bundle hash leaves
// the presentation out, so only the exact bundle tells them apart.
function otherPresentation(bundle) {
  const copy = structuredClone(bundle), entry = copy.presentation.signatures[0];
  entry.signature = `${entry.signature.slice(0, -1)}${entry.signature.endsWith('0') ? '1' : '0'}`;
  return copy;
}

test('a second plan request during a pending seller approval joins the running Vet; later requests reuse it', { timeout: 120000 }, async (t) => {
  const s = await setup(t);
  const { ctl, plan, provider, buyerBundle } = s;
  assert.equal(s.accepted(), 1, 'Listing CREATE only');
  const g1 = Date.now(), first = plan(g1);
  await s.waitForSellerPrompt();
  assert.equal(s.accepted(), 2, 'Listing and buyer CVR');
  const second = plan(g1 + 1000);
  assert.equal(await within(second, 1500), 'pending', 'the second request waits for the running Vet instead of signing a new record');
  assert.equal(s.prompted(ctl.buyerAddr), 1); assert.equal(s.prompted(ctl.sellerAddr), 1); assert.equal(s.accepted(), 2);
  ctl.sellerGate.resolve(true);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.disposition, 'present', JSON.stringify(a)); assert.equal(b.disposition, 'present', JSON.stringify(b));
  assert.deepEqual(b.input.buyer.vetRecordRef, a.input.buyer.vetRecordRef);
  assert.deepEqual(b.input.seller.vetRecordRef, a.input.seller.vetRecordRef);
  assert.equal(a.input.buyer.vetRecordRef.contentHash, (await s.journalStage(ctl.buyerAddr)).hash, 'the anchored buyer CVR');
  assert.equal(s.accepted(), 3, 'one more CREATE: the approved seller CVR');
  // A later request (a new generatedAt) reuses the job's Vet: no prompt, nothing sent.
  const later = await plan(g1 + 2000);
  assert.equal(later.disposition, 'present', JSON.stringify(later));
  assert.deepEqual(later.input.buyer.vetRecordRef, a.input.buyer.vetRecordRef);
  assert.equal(ctl.prompts.length, 3); assert.equal(s.accepted(), 3);
  assert.equal(provider.invocations.length, 2, 'one buyer and one seller Vet');
  // The seller is answered only from the exact context of a buyer request.
  const pin = s.published.listingPin;
  for (const generatedAt of [g1, g1 + 1000, g1 + 2000]) {
    const found = await provider.resolveSeller({ jobId: s.jobId, listingPin: pin, buyerIdentityBundle: buyerBundle, generatedAt });
    assert.equal(found.disposition, 'present', JSON.stringify(found)); assert.equal(found.value.input.generatedAt, generatedAt);
  }
  assert.deepEqual(await provider.resolveSeller({ jobId: s.jobId, listingPin: pin, buyerIdentityBundle: buyerBundle, generatedAt: g1 + 3000 }), { disposition: 'rejected', reason: 'seller context differs from buyer context' });
  assert.deepEqual(await provider.resolveSeller({ jobId: s.jobId, listingPin: pin, buyerIdentityBundle: otherPresentation(buyerBundle), generatedAt: g1 }), { disposition: 'rejected', reason: 'seller context differs from buyer context' });
  assert.deepEqual(await provider.resolveSeller({ jobId: s.jobId, listingPin: { ...pin, version: pin.version + 1 }, buyerIdentityBundle: buyerBundle, generatedAt: g1 }), { disposition: 'rejected', reason: 'seller context differs from buyer context' });
  assert.equal((await provider.resolveSeller({ jobId: generateCanonicalJobId(), listingPin: pin, buyerIdentityBundle: buyerBundle, generatedAt: g1 })).disposition, 'indeterminate');
});

test('a retry after the buyer CVR landed but its step failed replays the same signed record', { timeout: 120000 }, async (t) => {
  const s = await setup(t);
  const { ctl, plan } = s;
  ctl.sellerAuto = true; ctl.loseBuyerResponse = true; ctl.buyerReadsDown = true;
  const failed = await plan(Date.now());
  assert.equal(failed.disposition, 'indeterminate', JSON.stringify(failed));
  assert.match(failed.reason, /^DEM delivery context failed: buyer Vet record write failed \(indeterminate: the write outcome is not known yet\); Vet composite-anchor step failed: buyer CVR submission outcome is indeterminate; refusing to resubmit$/);
  assert.ok(ctl.writerLog.some((line) => line.includes('buyer CVR indeterminate: indeterminate: TEST write response lost')), 'the raw cause is logged server-side');
  const landed = await s.journalStage(ctl.buyerAddr);
  assert.equal(landed.stage, 'verified'); assert.equal(s.accepted(), 2, 'the buyer CVR CREATE was sent once');
  ctl.buyerReadsDown = false;
  const retry = await plan(Date.now() + 1000);
  assert.equal(retry.disposition, 'present', JSON.stringify(retry));
  assert.equal(retry.input.buyer.vetRecordRef.contentHash, landed.hash, 'the record signed and anchored by the first request');
  assert.equal(s.prompted(ctl.buyerAddr), 1, 'the buyer CVR was approved once'); assert.equal(s.accepted(), 3, 'only the seller CVR was added');
});

test('a retry after a transient seller-step failure keeps the anchored buyer CVR; the attempt note names the writer error', { timeout: 120000 }, async (t) => {
  const s = await setup(t);
  const { ctl, plan } = s;
  ctl.sellerAuto = true; ctl.transientSellerFailures = 1;
  const failed = await plan(Date.now());
  assert.equal(failed.disposition, 'indeterminate', JSON.stringify(failed));
  assert.match(failed.reason, /^DEM delivery context failed: seller Vet record write failed \(indeterminate: the write outcome is not known yet\); Vet composite-anchor step failed: seller CVR submission outcome is indeterminate; refusing to resubmit$/);
  assert.doesNotMatch(failed.reason, /nonce/, 'the raw writer text stays in the server log');
  assert.ok(ctl.writerLog.some((line) => line.includes('seller CVR indeterminate: indeterminate: seller nonce is unavailable')));
  const buyerCvr = await s.journalStage(ctl.buyerAddr);
  assert.equal(s.accepted(), 2, 'Listing and buyer CVR; the failed seller write sent nothing');
  const retry = await plan(Date.now() + 1000);
  assert.equal(retry.disposition, 'present', JSON.stringify(retry));
  assert.equal(retry.input.buyer.vetRecordRef.contentHash, buyerCvr.hash);
  assert.equal(s.prompted(ctl.buyerAddr), 1); assert.equal(s.accepted(), 3);
  assert.deepEqual(s.provider.invocations.map((entry) => entry.evaluatedParty), [s.buyer.signer.claim, s.published.listing.seller.identity.presentedBy], 'the finished buyer Vet is kept, not produced again');
});

test('a refused seller approval fails the joined requests and is never resent', { timeout: 120000 }, async (t) => {
  const s = await setup(t);
  const { ctl, plan } = s;
  const first = plan(Date.now());
  await s.waitForSellerPrompt();
  const second = plan(Date.now() + 1000);
  assert.equal(await within(second, 500), 'pending');
  ctl.sellerGate.resolve(false);
  for (const out of await Promise.all([first, second])) {
    assert.equal(out.disposition, 'indeterminate', JSON.stringify(out));
    assert.match(out.reason, /^DEM delivery context failed: seller Vet record write failed \(denied: the seller approval was refused\); /);
  }
  assert.equal((await s.journalStage(ctl.sellerAddr)).stage, 'denied');
  assert.equal(s.accepted(), 2, 'the refused CREATE was never sent');
  const retry = await plan(Date.now() + 2000);
  assert.equal(retry.disposition, 'indeterminate', JSON.stringify(retry));
  assert.match(retry.reason, /seller Vet record write failed/);
  assert.equal(ctl.prompts.length, 3, 'no new approval prompt'); assert.equal(s.accepted(), 2, 'nothing sent');
});

test('another buyer or identity bundle for the same job is refused and never joins its Vet', { timeout: 120000 }, async (t) => {
  const s = await setup(t);
  const { ctl, plan, provider, buyer, other, buyerBundle, otherBundle } = s;
  const g1 = Date.now(), first = plan(g1);
  await s.waitForSellerPrompt();
  const conflict = { disposition: 'rejected', reason: 'demo Agreement context scope conflict' };
  // The same purchase and presenter with another presentation.
  const changed = otherPresentation(buyerBundle);
  assert.equal(identityBundleHash(changed), identityBundleHash(buyerBundle));
  const otherScope = (generatedAt) => ({ source: 'TEST', account: 'acct_other', operation: 'pur_other', wallet: other.signer.address, jobId: s.jobId, buyer: other.signer.claim, buyerBundleHash: identityBundleHash(otherBundle),
    seller: s.published.listing.seller.identity.presentedBy, listingPin: s.published.listingPin, rail: { railId: DEM_RAIL.railId, railVersion: DEM_RAIL.railVersion }, payee: s.published.listing.seller.identity.presentedBy, price: { amount: '1', currency: 'DEM' }, generatedAt });
  const refusals = async (generatedAt) => {
    assert.deepEqual(await within(plan(generatedAt, changed), 1000), { value: conflict });
    // Another buyer naming this job (open buyer access admits the wallet).
    assert.deepEqual(await provider.resolveBuyer({ scope: otherScope(generatedAt), buyerIdentityBundle: otherBundle }), conflict);
  };
  await refusals(g1 + 1000);
  assert.equal(ctl.prompts.length, 3); assert.equal(s.accepted(), 2);
  ctl.sellerGate.resolve(true);
  assert.equal((await first).disposition, 'present');
  await refusals(g1 + 2000);
  await refusals(g1);
  assert.deepEqual(await provider.resolveSeller({ jobId: s.jobId, listingPin: s.published.listingPin, buyerIdentityBundle: changed, generatedAt: g1 }), { disposition: 'rejected', reason: 'seller context differs from buyer context' });
  assert.ok(provider.invocations.every((entry) => [buyer.signer.claim, s.published.listing.seller.identity.presentedBy].includes(entry.evaluatedParty)));
  assert.equal(ctl.prompts.length, 3); assert.equal(s.accepted(), 3);
});

// The code review's scratch test, mirrored from the buyer replay above: the
// seller's own checkpoints are replayed too.
test('a retry after the seller CVR landed but its response was lost reuses the same signed seller record', { timeout: 120000 }, async (t) => {
  const s = await setup(t);
  const { ctl, plan } = s;
  ctl.sellerAuto = true; ctl.loseSellerResponse = true; ctl.sellerReadsDown = true;
  const failed = await plan(Date.now());
  assert.equal(failed.disposition, 'indeterminate', JSON.stringify(failed));
  const landed = await s.journalStage(ctl.sellerAddr);
  assert.equal(landed.stage, 'verified'); assert.equal(s.accepted(), 3, 'Listing, buyer CVR, seller CVR sent once');
  ctl.sellerReadsDown = false;
  const retry = await plan(Date.now() + 1000);
  assert.equal(retry.disposition, 'present', JSON.stringify(retry));
  assert.equal(retry.input.seller.vetRecordRef.contentHash, landed.hash, 'the seller record anchored by the first request');
  assert.equal(s.prompted(ctl.sellerAddr), 1); assert.equal(s.prompted(ctl.buyerAddr), 1); assert.equal(s.accepted(), 3, 'nothing new sent');
  assert.equal(ctl.recordSignatures, 2, 'one buyer and one seller record signature');
});

// a review restart reproduction: the binding and both Vets' checkpoints are
// durable before any signature, so a new process replays them.
test('after a restart, a retry replays the buyer CVR that landed before its response was lost: no second signature, no new CREATE', { timeout: 120000 }, async (t) => {
  const s = await setup(t);
  const { ctl, plan } = s;
  ctl.sellerAuto = true; ctl.loseBuyerResponse = true; ctl.buyerReadsDown = true;
  const failed = await plan(Date.now());
  assert.equal(failed.disposition, 'indeterminate', JSON.stringify(failed));
  assert.equal(ctl.recordSignatures, 1, 'the buyer CVR was signed once'); assert.equal(s.accepted(), 2, 'Listing and the buyer CVR');
  const landed = await s.journalStage(ctl.buyerAddr);
  ctl.buyerReadsDown = false;
  const restarted = s.restart();
  const retry = await plan(Date.now() + 1000);
  assert.equal(retry.disposition, 'present', JSON.stringify(retry));
  assert.equal(retry.input.buyer.vetRecordRef.contentHash, landed.hash, 'the record signed before the restart');
  assert.equal(ctl.recordSignatures, 2, 'no second buyer signature: only the seller CVR was signed');
  assert.equal(s.accepted(), 3, 'only the seller CVR CREATE was added');
  assert.equal(s.prompted(ctl.buyerAddr), 1); assert.equal(s.prompted(ctl.sellerAddr), 1);
  assert.deepEqual(restarted.invocations.map((entry) => entry.evaluatedParty), [s.buyer.signer.claim, s.published.listing.seller.identity.presentedBy], 'one buyer and one seller Vet');
  const [held] = await s.vetState();
  assert.equal(held.writeStarted, true); assert.deepEqual(held.binding.buyerIdentityBundle, s.buyerBundle, 'the binding keeps the exact presentation');
});

test('after a restart, a retry after a transient seller-step failure replays both records and adds only the seller CREATE', { timeout: 120000 }, async (t) => {
  const s = await setup(t);
  const { ctl, plan } = s;
  ctl.sellerAuto = true; ctl.transientSellerFailures = 1;
  assert.equal((await plan(Date.now())).disposition, 'indeterminate');
  assert.equal(s.accepted(), 2); assert.equal(ctl.recordSignatures, 2, 'buyer CVR and the seller CVR signed before its write failed');
  const buyerCvr = await s.journalStage(ctl.buyerAddr);
  s.restart();
  const retry = await plan(Date.now() + 1000);
  assert.equal(retry.disposition, 'present', JSON.stringify(retry));
  assert.equal(retry.input.buyer.vetRecordRef.contentHash, buyerCvr.hash);
  assert.equal(ctl.recordSignatures, 2, 'nothing signed again'); assert.equal(s.accepted(), 3, 'one buyer and one seller CREATE');
  assert.equal(s.prompted(ctl.buyerAddr), 1); assert.equal(s.prompted(ctl.sellerAddr), 1);
});

test('after a restart, a later plan request for a finished job reuses its Vets: nothing signed or sent; another presentation is refused', { timeout: 120000 }, async (t) => {
  const s = await setup(t);
  const { ctl, plan } = s;
  ctl.sellerAuto = true;
  const first = await plan(Date.now());
  assert.equal(first.disposition, 'present', JSON.stringify(first));
  s.restart();
  const later = await plan(Date.now() + 1000);
  assert.equal(later.disposition, 'present', JSON.stringify(later));
  assert.deepEqual(later.input.buyer.vetRecordRef, first.input.buyer.vetRecordRef); assert.deepEqual(later.input.seller.vetRecordRef, first.input.seller.vetRecordRef);
  assert.equal(ctl.recordSignatures, 2); assert.equal(s.accepted(), 3); assert.equal(ctl.prompts.length, 3);
  assert.deepEqual(await plan(Date.now() + 2000, otherPresentation(s.buyerBundle)), { disposition: 'rejected', reason: 'demo Agreement context scope conflict' }, 'the durable binding outlives the restart');
});

// Code review P3-3: a binding under which nothing was ever written is dropped,
// so a fresh attempt can bind again; one under which a write may exist stays.
test('a run that fails before any write drops its binding; one that wrote keeps it, across a restart too', { timeout: 120000 }, async (t) => {
  const s = await setup(t);
  const { ctl, plan, buyerBundle } = s;
  ctl.sellerAuto = true;
  // A presentation that does not verify fails before anything is signed.
  const bad = await plan(Date.now(), badPresentation(buyerBundle));
  assert.equal(bad.disposition, 'indeterminate', JSON.stringify(bad)); assert.match(bad.reason, /presentation is not authenticated/);
  assert.equal(ctl.recordSignatures, 0); assert.deepEqual(await s.vetState(), [], 'the binding was dropped');
  // A run that stops before its first signature (its first checkpoint never
  // lands), then a restart: the retained binding has no write, so another
  // bundle may bind.
  ctl.storeUpdates = 0; ctl.onStoreUpdate = (n) => (n === 2 ? new Promise(() => {}) : undefined);
  const hung = plan(Date.now() + 1000);
  while (!(await s.vetState())[0]?.binding) await sleep(20);
  assert.equal(await within(hung, 200), 'pending');
  assert.equal((await s.vetState())[0].writeStarted, false);
  s.restart(); ctl.onStoreUpdate = null;
  const fresh = s.identity(s.buyer, Date.now() - 5000);
  assert.notEqual(identityBundleHash(fresh), identityBundleHash(buyerBundle));
  const good = await plan(Date.now() + 2000, fresh);
  assert.equal(good.disposition, 'present', JSON.stringify(good));
  assert.equal(ctl.recordSignatures, 2); assert.equal(s.accepted(), 3);
  // Now writes exist: any other bundle is refused, here and after a restart.
  const conflict = { disposition: 'rejected', reason: 'demo Agreement context scope conflict' };
  assert.deepEqual(await plan(Date.now() + 3000, buyerBundle), conflict);
  s.restart();
  assert.deepEqual(await plan(Date.now() + 4000, otherPresentation(fresh)), conflict);
  assert.equal((await plan(Date.now() + 5000, fresh)).disposition, 'present');
  assert.equal(ctl.recordSignatures, 2); assert.equal(s.accepted(), 3);
});

// a review P2: the purchase is read again right before each Vet signature or
// anchor intent; one no longer pending starts no new write.
test('a purchase no longer pending gets no Vet signature; its binding is dropped and nothing is sent', { timeout: 120000 }, async (t) => {
  const s = await setup(t);
  const { ctl, plan } = s;
  ctl.sellerAuto = true; ctl.writable = 'purchase is expired';
  const out = await plan(Date.now());
  assert.equal(out.disposition, 'indeterminate', JSON.stringify(out));
  assert.match(out.reason, /^DEM delivery context failed: buyer Vet record write failed \(not-pending: the purchase is no longer pending; no new write was started\); /);
  assert.equal(ctl.recordSignatures, 0); assert.equal(s.accepted(), 1, 'Listing only'); assert.equal(ctl.prompts.length, 1);
  assert.deepEqual(await s.vetState(), [], 'the binding was dropped');
});

test('after expiry, a write that may exist is only read back and no new one starts', { timeout: 120000 }, async (t) => {
  const s = await setup(t);
  const { ctl, plan } = s;
  // The buyer CVR lands but its response is lost and its readback is down.
  ctl.sellerAuto = true; ctl.loseBuyerResponse = true; ctl.buyerReadsDown = true;
  assert.equal((await plan(Date.now())).disposition, 'indeterminate');
  assert.equal(ctl.recordSignatures, 1); assert.equal(s.accepted(), 2);
  ctl.buyerReadsDown = false; ctl.writable = 'the purchase approval window elapsed';
  const expired = await plan(Date.now() + 1000);
  assert.equal(expired.disposition, 'indeterminate', JSON.stringify(expired));
  assert.match(expired.reason, /seller Vet record write failed \(not-pending: /, 'the buyer CVR was found by readback; the seller CVR was not signed');
  assert.equal(ctl.recordSignatures, 1, 'no seller signature'); assert.equal(s.accepted(), 2, 'no CREATE');
  assert.equal(s.prompted(ctl.sellerAddr), 0);
  // A seller CVR signed before expiry, whose write failed before it was sent, is not written after it.
  ctl.writable = true; ctl.transientSellerFailures = 1;
  assert.equal((await plan(Date.now() + 2000)).disposition, 'indeterminate');
  assert.equal(ctl.recordSignatures, 2, 'the seller CVR was signed; its write failed first');
  ctl.writable = 'purchase is cancelled';
  const cancelled = await plan(Date.now() + 3000);
  assert.match(cancelled.reason, /seller Vet record write failed \(not-pending: /);
  assert.equal(ctl.recordSignatures, 2); assert.equal(s.accepted(), 2); assert.equal(s.prompted(ctl.sellerAddr), 0);
});

// Code review P3-4: a saved plan keeps only its own request's context (for the
// seller); an ended purchase keeps none, and its durable row is deleted.
test('a saved plan or an ended purchase releases the job\'s entries; an ended job\'s row is deleted and the job is then refused as legacy', { timeout: 120000 }, async (t) => {
  const s = await setup(t);
  const { ctl, plan, provider, buyerBundle } = s;
  ctl.sellerAuto = true;
  const g1 = Date.now();
  assert.equal((await plan(g1)).disposition, 'present'); assert.equal((await plan(g1 + 1000)).disposition, 'present');
  assert.equal(provider.contexts.size, 2);
  const pin = s.published.listingPin, seller = (generatedAt) => provider.resolveSeller({ jobId: s.jobId, listingPin: pin, buyerIdentityBundle: buyerBundle, generatedAt });
  releaseDemDeliveryContext(s.capability, { jobId: s.jobId, generatedAt: g1 + 1000 });
  assert.equal(provider.contexts.size, 1);
  assert.equal((await seller(g1 + 1000)).disposition, 'present'); assert.equal((await seller(g1)).disposition, 'rejected');
  assert.deepEqual((await s.vetState())[0].seller.generatedAts, [g1 + 1000], 'the row keeps only the saved request\'s time');
  releaseDemDeliveryContext(s.capability, { jobId: s.jobId });
  assert.equal(provider.contexts.size, 0);
  while ((await s.vetState()).length) await sleep(10);
  assert.equal((await seller(g1 + 1000)).disposition, 'indeterminate');
  // The row is gone and the job's CVR intents stay in the artifact journal:
  // were the job asked for again (an ended purchase never is: it is refused
  // before the provider), it is quarantined, and nothing is signed or sent.
  const again = await plan(g1 + 2000);
  assert.equal(again.disposition, 'rejected', JSON.stringify(again)); assert.match(again.reason, /^legacy_party_vet_state_missing: /);
  assert.equal(ctl.recordSignatures, 2); assert.equal(s.accepted(), 3); assert.equal(ctl.prompts.length, 3);
});
