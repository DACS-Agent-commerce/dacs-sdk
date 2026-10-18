import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, sha256Hex, contentHash } from '@kynesyslabs/dacs';
import { gatedWallet, fixturePurchase, withListingHash, viewFor, identityFor, signedMessages, DAY } from './helpers/start-intent.mjs';
import { buildIntent, describeIntent, DEVNET_CREATE_KIND } from '../public/portal-intent/intent.mjs';
import { createIntentGate } from '../public/portal-intent/gate.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { attachIdentityPresentation } from '../src/dacs/listing.mjs';
import { planAgreement } from '../src/dacs/purchase-protocol.mjs';
import { renderChallengeMessage, PURPOSES } from '../src/wallet/challenges.mjs';

const w = await gatedWallet();
const now = Date.now();
const refused = (e) => e.code === 'intent_mismatch';
async function facts({ devnet = false, delegation = false } = {}) {
  const p = await withListingHash(fixturePurchase({ address: w.address, now, devnet }));
  if (delegation) p.terms.protocol.sellerTransport = { delegation: true };
  const payload = delegation ? { version: '1', kind: 'seller-session-delegation', buyer: `did:demos:agent:${w.address.slice(2)}`, sessionPublicKey: createEphemeralWallet().claim.slice('did:demos:agent:'.length), seller: p.seller.claim, listingPin: {...p.terms.listing}, jobId: p.jobId, notBefore: now - 1000, expiresAt: now + 3600000 } : null;
  const view = viewFor(p, { now, delegation: payload });
  const unsigned = identityFor(p, w.address, now);
  // This fixture is also valid with the untouched HEAD helpers.
  Object.assign(view.start, { listing: p.listing, agreement: { generatedAt: now }, identity: { bundle: unsigned.bundle }, delegation: payload ? { payload } : null });
  const intent = await buildIntent({ view, start: view.start, wallet: w.address, now });
  return { p, view, unsigned, intent, payload };
}
async function planned(devnet = false) {
  const f = await facts({ devnet });
  await w.gate.open(f.intent);
  const sig = await w.gate.signIdentity(f.unsigned.bundle);
  const plan = planAgreement({ jobId: f.p.jobId, listing: f.p.listing, buyerBundle: attachIdentityPresentation(f.unsigned, sig), generatedAt: now });
  return { ...f, plan };
}

for (const [name, mutate] of [
  ['deliverable', d => { d.terms.deliverable = { deliverableType: 'entitlement', hash: 'f'.repeat(64) }; }],
  ['seller identity hash', d => { d.parties[1].bundleHash = 'f'.repeat(64); }],
  ['exact generation time', d => { d.generatedAt += 1; d.terms.deadline += 1; }],
  ['Listing-derived deadline', d => { d.terms.deadline += 1000; }],
  ['vet content hash', d => { d.parties[1].vetRecordRef.contentHash = 'f'.repeat(64); }],
  ['vet composite address', d => { d.parties[1].vetRecordRef.anchor.locator += 'x'; }],
  ['payout phase', d => { d.terms.payoutBindings[0].phaseIndex = 1; }],
  ['payout rail', d => { d.terms.payoutBindings[0].railId = 'other'; }],
  ['party role', d => { d.parties[0].role = 'seller'; }],
  ['future generation bound', d => { d.generatedAt = now + DAY; d.terms.deadline += DAY; }],
  ['past generation bound', d => { d.generatedAt = now - 2 * DAY; d.terms.deadline -= 2 * DAY; }],
]) {
  test(`Agreement refuses ${name} before signing`, async () => {
    const f = await planned(); const draft = structuredClone(f.plan.draft); mutate(draft);
    const before = signedMessages.length;
    await assert.rejects(w.gate.signAgreement(draft), e => refused(e) && (name.includes('generation bound') ? /generation time is out of range/.test(e.message) : name === 'Listing-derived deadline' ? e.field === 'deadline' : true));
    assert.equal(signedMessages.length, before);
    w.gate.finish();
  });
}
for (const [name, mutate] of [
  ['session key', d => { d.sessionPublicKey = 'ef'.repeat(32); }],
  ['notBefore', d => { d.notBefore -= 1; }],
  ['expiresAt', d => { d.expiresAt -= 1; }],
]) {
  test(`delegation refuses substituted ${name} with nothing signed`, async () => {
    const f = await facts({ delegation: true }); await w.gate.open(f.intent);
    const shown = w.dialogs.at(-1).message;
    assert.ok(shown.includes(f.payload.sessionPublicKey));
    assert.ok(shown.includes(new Date(f.payload.notBefore).toISOString()));
    assert.ok(shown.includes(new Date(f.payload.expiresAt).toISOString()));
    const changed = structuredClone(f.payload); mutate(changed);
    const before = signedMessages.length;
    await assert.rejects(w.gate.signDelegation(changed), refused);
    assert.equal(signedMessages.length, before); w.gate.finish();
  });
}
test('delegation cannot outlive the Start by more than a day', async () => {
  const f = await facts({ delegation: true });
  // A window valid under the seller checker, but too far ahead of this short Start.
  f.view.start.intent.expiresAt = new Date(now + 1000).toISOString();
  f.payload.notBefore = now + 2000; f.payload.expiresAt = now + DAY + 2000;
  const before = signedMessages.length;
  await assert.rejects(buildIntent({ view: f.view, start: f.view.start, wallet: w.address, now }), e => refused(e) && /outlives/.test(e.message));
  assert.equal(signedMessages.length, before);
});
for (const [name, mutate] of [
  ['listing newline', t => { t.listing.listingId = 'seller\nPrice: 0.01 DEM'; }],
  ['network bidi', t => { t.network = 'demos\u202edevnet'; t.domain.network = t.network; }],
  ['account newline', t => { t.buyer.accountId = 'acct_a\nWallet writes covered: none'; }],
  ['price disagreement', t => { t.price.amountOs = '1'; }],
  ['rail mismatch', t => { t.domain.rail = 'other'; }],
  ['self seller', t => { t.seller.claim = `did:demos:agent:${w.address.slice(2)}`; t.seller.payee = w.address; }],
  ['fixture mode mismatch', t => { t.domain.mode = 'public-chain-read'; }],
]) {
  test(`Start refuses ${name} before a dialog`, async () => {
    const f = await facts(); mutate(f.view.terms);
    if (name === 'listing newline') { f.view.start.listing = structuredClone(f.p.listing); f.view.start.listing.listingId = f.view.terms.listing.listingId; f.view.terms.listing.contentHash = contentHash(f.view.start.listing); }
    f.view.termsHash = sha256Hex(canonicalize(f.view.terms));
    const before = w.dialogs.length;
    await assert.rejects(buildIntent({ view: f.view, start: f.view.start, wallet: w.address, now }), refused);
    assert.equal(w.dialogs.length, before);
  });
}
test('Start refuses a purchase id with a fake dialog line', async () => {
  const f = await facts(); f.view.id += '\nPrice: 0.01 DEM';
  f.view.start.identity.bundle = identityFor({...f.p, id: f.view.id}, w.address, now).bundle;
  await assert.rejects(buildIntent({ view: f.view, start: f.view.start, wallet: w.address, now }), refused);
});
test('Start hash-checks the supplied Listing before approval', async () => {
  const f = await facts(); f.view.start.listing = structuredClone(f.p.listing); f.view.start.listing.offering.deliverable.schemaUrl = 'https://attacker.invalid';
  await assert.rejects(buildIntent({ view: f.view, start: f.view.start, wallet: w.address, now }), refused);
});
test('context profiles refuse one approval until buyer Vet material is verifiable', async () => {
  const f = await facts({ devnet: true }); f.view.terms.protocol.agreementContext = 'dacs-chatgpt-plugin/dem-delivery-context/v1'; f.view.termsHash = sha256Hex(canonicalize(f.view.terms));
  await assert.rejects(buildIntent({ view: f.view, start: f.view.start, wallet: w.address, now }), refused);
});
test('devnet dialog includes source-pin and finality caveats and the exact deadline', async () => {
  const f = await facts({ devnet: true }); const text = describeIntent(f.intent);
  assert.match(text, /single node, finality not established/);
  assert.match(text, /independently supplied source pin/);
  assert.ok(text.includes(new Date(now + f.p.listing.terms.deadlineSecAfterCommit * 1000).toISOString()));
});
for (const [name, issued, expires] of [['expired', now - 600000, now - 1], ['future', now + DAY, now + DAY + 60000]]) {
  test(`broker refuses a ${name} challenge before signing`, async () => {
    const f = await planned(true); await w.gate.noteAgreement(f.plan.draft);
    const origin = 'http://127.0.0.1:8787';
    const message = renderChallengeMessage({ origin, purpose: PURPOSES.OFFLINE_AGREEMENT_BROKER, address: w.address, nonce: 'n'.repeat(22), issuedAt: new Date(issued).toISOString(), expiresAt: new Date(expires).toISOString(), binding: {
      account: f.intent.account, operation: f.p.id, wallet: w.address, 'terms-hash': f.view.termsHash, job: f.p.jobId, 'agreement-hash': f.plan.plan.agreementHash, network: 'demos-devnet', authorization: 'one immutable Agreement CREATE; no payment or completion',
    } });
    const before = signedMessages.length; await assert.rejects(w.gate.signBrokerChallenge(message, { origin }), refused);
    assert.equal(signedMessages.length, before); w.gate.finish();
  });
}
for (const bad of ['address', 'debit']) {
  test(`CREATE refuses wrong ${bad} before broadcast`, async () => {
    const f = await planned(true); await w.gate.noteAgreement(f.plan.draft); w.gate.expectAgreementCreate();
    const content = { kind: DEVNET_CREATE_KIND, artifactKind: 'Agreement', jobId: f.p.jobId, logicalAddress: `dacs3:agreement:${f.p.jobId}`, owner: f.intent.buyer, wallet: w.address, contentHash: f.plan.plan.agreementHash, exactStorageBytes: JSON.stringify(f.plan.draft), network: f.intent.network.name, chainIdentity: f.intent.network.chainIdentity, nonce: 1, debit: { totalOs: '1' } };
    if (bad === 'debit') delete content.debit;
    const before = signedMessages.length; let broadcasts = 0;
    if (await w.gate.approve({ method: 'sendTransaction', address: bad === 'address' ? '0x' + 'f'.repeat(64) : w.address, content })) broadcasts++;
    assert.equal(broadcasts, 0); assert.equal(signedMessages.length, before); w.gate.finish();
  });
}
test('an older pending approval cannot revive after a newer open', async () => {
  const f = await facts(); let resolveFirst; let calls = 0;
  const gate = createIntentGate({ approve: () => ++calls === 1 ? new Promise(r => { resolveFirst = r; }) : false, now: () => now });
  gate.attach(w.session);
  const older = gate.open(f.intent); const rejected = assert.rejects(older, refused);
  await assert.rejects(gate.open(f.intent), refused); resolveFirst(true); await rejected;
  assert.equal(gate.active, false);
  await assert.rejects(gate.signIdentity(f.unsigned.bundle), refused);
});
test('lock invalidates a pending approval even when unlocked before it finishes', async () => {
  const f = await facts(); let resolve;
  const gate = createIntentGate({ approve: () => new Promise(r => { resolve = r; }), now: () => now }); gate.attach(w.session);
  const opening = gate.open(f.intent); const rejected = assert.rejects(opening, refused);
  gate.finish(); resolve(true); await rejected; assert.equal(gate.active, false);
});
test('a peer tab invalidates an active Start', async () => {
  const f = await facts(); const gate = createIntentGate({ approve: () => true, now: () => now }); gate.attach(w.session); await gate.open(f.intent);
  assert.equal(typeof gate.peerStarted, 'function');
  gate.peerStarted({ type: 'dacs-chatgpt-plugin/start-intent/opened/v1', wallet: w.address });
  assert.equal(gate.active, false); await assert.rejects(gate.signIdentity(f.unsigned.bundle), refused);
});

test('identity refuses extra unsigned fields before signing', async () => {
  const f = await facts(); await w.gate.open(f.intent); const before = signedMessages.length;
  await assert.rejects(w.gate.signIdentity({...f.unsigned.bundle, extra: 'attacker'}), e => refused(e) && /unexpected shape/.test(e.message));
  assert.equal(signedMessages.length, before); w.gate.finish();
});
test('Start refuses a chain different from the pinned transport', async () => {
  const f = await facts({devnet: true}); f.view.terms.protocol.transportBinding.chainIdentity = 'ff'.repeat(32); f.view.termsHash = sha256Hex(canonicalize(f.view.terms));
  await assert.rejects(buildIntent({view: f.view, start: f.view.start, wallet: w.address, now}), e => refused(e) && e.field === 'network');
});
test('Start refuses an already expired server record', async () => {
  const f = await facts(); f.view.start.intent.expiresAt = new Date(now - 1).toISOString();
  await assert.rejects(buildIntent({view: f.view, start: f.view.start, wallet: w.address, now}), e => refused(e) && e.field === 'expiry');
});

test('Start refuses a stale identity presentation before any dialog', async () => {
  const f = await facts(); f.view.start.identity.bundle = identityFor(f.p, w.address, now - 2 * DAY).bundle;
  await assert.rejects(buildIntent({view: f.view, start: f.view.start, wallet: w.address, now}), e => refused(e) && e.field === 'identity');
});

test('delegation expiry is checked again at signing time', async () => {
  const f = await facts({delegation: true}); f.payload.expiresAt = now + 1000;
  const intent = await buildIntent({view: f.view, start: f.view.start, wallet: w.address, now});
  const { checkSellerSessionDelegation } = await import('../public/portal/seller-session-delegation.mjs');
  const { delegationMessage } = await import('../public/portal-intent/intent.mjs');
  const before = signedMessages.length;
  assert.throws(() => delegationMessage(intent, f.payload, {now: now + 1001, check: checkSellerSessionDelegation}), refused);
  assert.equal(signedMessages.length, before);
});

for (const step of ['identity readback', 'Agreement readback', 'CREATE check']) {
  test(`a newer Start invalidates an in-flight ${step}`, async () => {
    const f = await planned(true);
    if (step === 'CREATE check') { await w.gate.noteAgreement(f.plan.draft); w.gate.expectAgreementCreate(); }
    const original = crypto.subtle.digest.bind(crypto.subtle); let release; let began;
    const paused = new Promise(r => {began = r;}); let first = true;
    crypto.subtle.digest = async (...args) => { if (first) {first = false; began(); await new Promise(r => {release = r;});} return original(...args); };
    try {
      const pending = step === 'identity readback' ? w.gate.noteIdentity(f.unsigned.bundle) : step === 'Agreement readback' ? w.gate.noteAgreement(f.plan.draft) : w.gate.approve({method: 'sendTransaction', address: w.address, content: {
        kind: DEVNET_CREATE_KIND, artifactKind: 'Agreement', jobId: f.p.jobId, logicalAddress: `dacs3:agreement:${f.p.jobId}`, owner: f.intent.buyer, wallet: w.address, contentHash: f.plan.plan.agreementHash, exactStorageBytes: JSON.stringify(f.plan.draft), network: f.intent.network.name, chainIdentity: f.intent.network.chainIdentity, nonce: 1, debit: {totalOs: '1'},
      }});
      const rejected = step === 'CREATE check' ? null : assert.rejects(pending, refused);
      await paused; await w.gate.open(f.intent); release();
      if (rejected) await rejected; else assert.equal(await pending, false);
    } finally {crypto.subtle.digest = original; w.gate.finish();}
  });
}
test('a newer Start during a durable signature claim makes no SDK request', async () => {
  const f = await facts(); let release; let began; const paused = new Promise(r => {began = r;}); let requests = 0;
  const gate = createIntentGate({approve: () => true, now: () => now, claimSignature: () => {began(); return new Promise(r => {release = r;});}});
  gate.attach({isLocked: () => false, getPublicAccount: () => ({address: w.address}), request: async () => {requests++; return {success: true, data: {signature: 'signature'}};}});
  await gate.open(f.intent); const pending = gate.signIdentity(f.unsigned.bundle); const rejected = assert.rejects(pending, refused);
  await paused; await gate.open(f.intent); release(); await rejected; assert.equal(requests, 0);
});

// The pinned Listing must be the one the terms name, by the seller they name,
// even when its hash is the one in the terms.
async function withListing(mutate) {
  const f = await facts(); f.view.start.listing = structuredClone(f.p.listing); mutate(f.view.start.listing);
  f.view.terms.listing.contentHash = contentHash(f.view.start.listing); f.view.termsHash = sha256Hex(canonicalize(f.view.terms));
  return f;
}
for (const [name, mutate, reason] of [
  ['another seller presenting it', l => { l.seller.identity.presentedBy = createEphemeralWallet().claim; }, /belongs to another seller/],
  ['another Listing version', l => { l.listingVersion += 1; }, /another Listing or version/],
  ['another Listing id', l => { l.listingId += '-other'; }, /another Listing or version/],
  ['a schema with spaces that wraps into a fake line', l => { l.offering.deliverable.schemaUrl = `https://s/x.json${' '.repeat(120)}Price: 0.01 DEM (10000000 OS)`; }, /deliverable schema is malformed/],
  ['a schema with a no-break space', l => { l.offering.deliverable.schemaUrl = `urn:x${String.fromCharCode(0xa0)}Price:`; }, /deliverable schema is malformed/],
  ['a schema that is not an absolute URI', l => { l.offering.deliverable.schemaUrl = 'fixture'; }, /deliverable schema is malformed/],
]) {
  test(`Start refuses a hash-matching Listing with ${name} before a dialog`, async () => {
    const f = await withListing(mutate); const before = w.dialogs.length;
    await assert.rejects(buildIntent({ view: f.view, start: f.view.start, wallet: w.address, now }), e => refused(e) && e.field === 'listing' && reason.test(e.message));
    assert.equal(w.dialogs.length, before);
  });
}
test('Start accepts urn: and https: deliverable schemas', async () => {
  for (const schemaUrl of ['urn:dacs-chatgpt-plugin:v0.1:seller-defined-delivery', 'https://schemas.example/delivery.json']) {
    const f = await withListing(l => { l.offering.deliverable.schemaUrl = schemaUrl; });
    const intent = await buildIntent({ view: f.view, start: f.view.start, wallet: w.address, now });
    assert.ok(describeIntent(intent).includes(`(schema ${schemaUrl})`));
  }
});
test('the dialog shows the deliverable, generation time and both identity hashes', async () => {
  const f = await facts(); const lines = describeIntent(f.intent).split('\n');
  const deliverable = f.p.listing.offering.deliverable;
  const { presentation: _presentation, ...sellerIdentity } = f.p.listing.seller.identity;
  for (const line of [
    `Deliverable: ${deliverable.kind} (schema ${deliverable.schemaUrl}), hash ${sha256Hex(canonicalize(deliverable))}`,
    `Agreement generated at: ${new Date(now).toISOString()}`,
    `Buyer identity: hash ${sha256Hex(canonicalize(f.unsigned.bundle))}, presented ${new Date(f.unsigned.bundle.presentedAt).toISOString()}`,
    `Seller identity: hash ${sha256Hex(canonicalize(sellerIdentity))}`,
  ]) assert.ok(lines.includes(line), line);
});
test('a peer tab Start invalidates a Start dialog still open in this tab', async () => {
  const f = await facts(); let resolve;
  const gate = createIntentGate({ approve: () => new Promise(r => { resolve = r; }), now: () => now }); gate.attach(w.session);
  const opening = gate.open(f.intent); const rejected = assert.rejects(opening, e => refused(e) && e.field === 'superseded');
  gate.peerStarted({ type: 'dacs-chatgpt-plugin/start-intent/opened/v1', wallet: w.address });
  resolve(true); await rejected; assert.equal(gate.active, false);
  await assert.rejects(gate.signIdentity(f.unsigned.bundle), refused);
});
