// The devnet demo Agreement context provider over the fixture chain, no
// network: the real anchor, listing publisher, packaged seller wallet and
// provider, driven through the DEM delivery context consumer with an exact
// purchase scope. The seller approval is programmable; buyer access is open,
// as on the live server.
//
// durable: the artifact journal and the party Vet store are SQLite files, and
// restart() opens new instances of both on the same files, a new anchor and a
// new provider, the way a restarted server would (an abandoned instance keeps
// any hung work and lock rows, as a killed process leaves them). Otherwise
// both are in memory and restart() builds only a new provider over them.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compositeVerificationAddress, generateCanonicalJobId } from '@kynesyslabs/dacs';
import { startDevnetLiveCompositionTransport } from './devnet-live-composition-transport.mjs';
import { createDevnetAgreementWalletTransport } from '../../public/portal/embedded-wallet/sdk-provider.mjs';
import { createEphemeralPackagedSeller } from './native-settlement-consumer-seller.mjs';
import { fixtureIdentityBundle, fixtureListing } from '../fixtures/listings.mjs';
import { createOperatorBuyerAccess } from '../../src/devnet-demo/buyer-access.mjs';
import { createDevnetDemoArtifactAnchor } from '../../src/devnet-demo/artifact-anchor.mjs';
import { createDevnetDemoListingPublisher } from '../../src/devnet-demo/listing.mjs';
import { createDevnetDemoAgreementContextProvider } from '../../src/devnet-demo/agreement-context.mjs';
import { createInMemoryPartyVetStore, openPartyVetStore } from '../../src/devnet-demo/party-vet-store.mjs';
import { createDemDeliveryContext, resolveDemDeliveryBuyerContext } from '../../src/dacs/dem-delivery-context-consumer.mjs';
import { openDurableWalletJournal } from '../../src/wallet/durable-journal.mjs';
import { DEM_RAIL } from '../../src/dacs/listing.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const never = () => new Promise(() => {});
export const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };
// Settles within ms, or reports that it is still pending.
export const within = (promise, ms) => Promise.race([promise.then((value) => ({ value }), (error) => ({ error })), sleep(ms).then(() => 'pending')]);
export function memoryJournal(){const rows=new Map(),tails=new Map();return{get:async(k)=>structuredClone(rows.get(k)??null),put:async(k,v)=>rows.set(k,structuredClone(v)),entries:async()=>[...rows.entries()].map(([k,v])=>[k,structuredClone(v)]),async withWalletLock(k,work){const prior=tails.get(k)??Promise.resolve();let release;const next=new Promise(r=>release=r);tails.set(k,next);await prior;try{return await work();}finally{release();if(tails.get(k)===next)tails.delete(k);}}};}
const railAuthority=()=>({trustPhase:'PA-1',trustPolicyAcceptsPA1:true,registry:{state:'not-used',entries:[],definitions:[]},inCodeDefinitions:[{railId:DEM_RAIL.railId,railVersion:DEM_RAIL.railVersion,phaseHandler:'pay-dem',governanceAnchoring:'in-code',signatureValid:true}]});

export async function setupPartyVet(t, { durable = false, journalOptions = {}, storeOptions = {}, listingId = 'single-vet', jobId = generateCanonicalJobId() } = {}) {
  const harness = await startDevnetLiveCompositionTransport();
  t.after(() => harness.close());
  globalThis.location = new URL(harness.origin); globalThis.window ??= globalThis; globalThis.document ??= { baseURI: `${harness.origin}/portal/assets/embedded-wallet/`, currentScript: null };
  const transport = createDevnetAgreementWalletTransport(harness.capability.profile(harness.origin));
  const ctl = { buyerAddr: null, sellerAddr: null, sellerGate: deferred(), sellerAuto: false, prompts: [], transientSellerFailures: 0, loseBuyerResponse: false, loseSellerResponse: false, buyerReadsDown: false, sellerReadsDown: false,
    recordSignatures: 0, signed: [], writable: true, writerLog: [], storeUpdates: 0, onStoreUpdate: null, afterStoreUpdate: null, onReconcile: null, onSign: null,
    anchorCalls: { publish: 0, read: 0, readRetained: 0, hasIntent: 0 } };
  // The seller's TTY approval: the buyer CVR after a short human delay; the
  // seller's own CVR waits for sellerGate unless sellerAuto.
  const approve = async (r) => {
    const addr = r.content?.logicalAddress, kind = r.content?.artifactKind;
    ctl.prompts.push({ kind, addr });
    if (kind === 'Listing') return true;
    if (addr === ctl.buyerAddr) { await sleep(100); return true; }
    if (addr === ctl.sellerAddr) return ctl.sellerAuto || ctl.sellerGate.p;
    return false;
  };
  const seller = await createEphemeralPackagedSeller({ network: 'demos-devnet', transactionTransport: transport, approve }); t.after(() => seller.close());
  const buyer = await createEphemeralPackagedSeller({ network: 'demos-devnet', transactionTransport: transport }); t.after(() => buyer.close());
  const other = await createEphemeralPackagedSeller({ network: 'demos-devnet', transactionTransport: transport }); t.after(() => other.close());
  const dir = durable ? mkdtempSync(join(tmpdir(), 'party-vet-')) : null;
  const instances = [];
  if (dir) t.after(() => { for (const close of instances) { try { close(); } catch { /* abandoned with hung work */ } } rmSync(dir, { recursive: true, force: true }); });
  const openJournal = (mode) => { if (!dir) return memoryJournal(); const j = openDurableWalletJournal({ path: join(dir, 'seller-artifacts.sqlite'), mode, ...journalOptions }); instances.push(() => j.close()); return j; };
  const openStore = () => { if (!dir) return createInMemoryPartyVetStore(storeOptions); const s = openPartyVetStore({ path: join(dir, 'seller-party-vet.sqlite'), ...storeOptions }); instances.push(() => s.close()); return s; };
  const buyerAccess = createOperatorBuyerAccess({ openBuyerAccess: true });
  // The anchor reads its whole journal only to reconcile a prior wallet lane,
  // inside publish under the address lock: ctl.onReconcile runs there.
  const gated = (journal) => ({ ...journal, entries: async () => { await ctl.onReconcile?.(); return journal.entries(); } });
  const makeAnchor = (journal) => createDevnetDemoArtifactAnchor({ sourceCapability: harness.capability, journal: gated(journal), walletFactory: seller.walletFactory, network: harness.capability.pins.network, signer: { claim: seller.signer.claim, sign: (b) => seller.signer.signBytes(b) }, buyerAccess });
  let journal = openJournal('create'), anchor = makeAnchor(journal), store = openStore();
  const { signature: _s, ...listingDraft } = fixtureListing(seller.signer, { listingId, version: 1, now: Date.now() - 1000, notAfter: Date.now() + 86400000 });
  const published = await createDevnetDemoListingPublisher({ anchor, sign: (b) => seller.signer.signBytes(b), scanOwnListings: async () => ({ status: 'ok', anchors: [] }), loadRailResolution: railAuthority })(listingDraft);
  // The real anchor, with TEST faults: a seller write that fails before
  // anything is written or sent, a write whose response is lost after the
  // CREATE landed, readbacks that are briefly unavailable, and a hook run
  // inside publish (under no lock) before the real anchor.
  const wrap = (real) => Object.freeze({ ...real,
    hasIntent: (address) => { ctl.anchorCalls.hasIntent += 1; return real.hasIntent(address); },
    read: (input) => { ctl.anchorCalls.read += 1; return real.read(input); },
    publish: async (input) => {
      ctl.anchorCalls.publish += 1;
      if (input.logicalAddress === ctl.sellerAddr && ctl.transientSellerFailures > 0) { ctl.transientSellerFailures -= 1; throw Object.assign(new Error('seller nonce is unavailable'), { code: 'indeterminate' }); }
      const out = await real.publish(input);
      if (input.logicalAddress === ctl.buyerAddr && ctl.loseBuyerResponse) { ctl.loseBuyerResponse = false; throw Object.assign(new Error('TEST write response lost'), { code: 'indeterminate' }); }
      if (input.logicalAddress === ctl.sellerAddr && ctl.loseSellerResponse) { ctl.loseSellerResponse = false; throw Object.assign(new Error('TEST seller write response lost'), { code: 'indeterminate' }); }
      return out;
    },
    readRetained: async (input) => {
      ctl.anchorCalls.readRetained += 1;
      return (input.logicalAddress === ctl.buyerAddr && ctl.buyerReadsDown) || (input.logicalAddress === ctl.sellerAddr && ctl.sellerReadsDown) ? { status: 'indeterminate', reason: 'TEST readback unavailable', noResend: true } : real.readRetained(input);
    },
  });
  // Each provider sees the store through a counter: onStoreUpdate(n, key,
  // mine) may hold or fail a change before it runs (n counts every
  // provider's changes, mine this provider's), afterStoreUpdate(n, row, mine)
  // may hold its caller after it was stored. A provider may get its own hooks
  // or its own store. hooks.signBytes may replace the Vet signer to exercise
  // a nondeterministic provider while retaining the byte/signature counters.
  const counted = (real, hooks) => { let mine = 0; return Object.freeze({ ...real, update: async (key, change) => {
    const n = (ctl.storeUpdates += 1), own = (mine += 1), before = hooks.onStoreUpdate ?? ctl.onStoreUpdate, after = hooks.afterStoreUpdate ?? ctl.afterStoreUpdate;
    await before?.(n, key, own);
    const row = await real.update(key, change);
    await after?.(n, row, own);
    return row;
  } }); };
  const build = (hooks = {}) => createDevnetDemoAgreementContextProvider({ anchor: wrap(anchor), store: counted(hooks.store ?? store, hooks), listing: published.listing, buyerAccess, log: (line) => ctl.writerLog.push(line),
    wallet: { claim: seller.signer.claim, signBytes: async (b) => { await ctl.onSign?.(ctl.recordSignatures + 1); ctl.recordSignatures += 1; const signature = hooks.signBytes ? await hooks.signBytes(b) : seller.signer.signBytes(b); ctl.signed.push({ bytes: Buffer.from(b).toString('hex'), signature: Buffer.from(signature).toString('hex') }); return signature; } } });
  const capabilityFor = (built) => createDemDeliveryContext({ authority: 'TEST-single-vet', resolveBuyer: built.resolveBuyer, resolveSeller: built.resolveSeller, release: built.release, usage: built.usage });
  let provider = build(), capability = capabilityFor(provider);
  const restart = () => {
    if (dir) { journal = openJournal('open'); anchor = makeAnchor(journal); store = openStore(); }
    provider = build(); capability = capabilityFor(provider); return provider;
  };
  const identity = (wallet, at = Date.now() - 1000) => fixtureIdentityBundle(wallet.signer, at - 1000);
  const buyerBundle = identity(buyer), otherBundle = identity(other);
  let operation;
  // Moves the fixture to another job (another purchase of the same Listing).
  const switchJob = (next = generateCanonicalJobId()) => {
    jobId = next; ctl.buyerAddr = compositeVerificationAddress(jobId, buyer.signer.claim); ctl.sellerAddr = compositeVerificationAddress(jobId, seller.signer.claim);
    operation = { id: `pur_single_vet_${jobId.slice(-6)}`, accountId: 'acct_single_vet', terms: { buyer: { wallet: buyer.signer.address }, protocol: { jobId },
      seller: { claim: seller.signer.claim, payee: seller.signer.address }, listing: { ...published.listingPin }, price: { amount: '1', currency: 'DEM' } } };
    return jobId;
  };
  switchJob(jobId);
  // One plan step's context read, exactly as protocol-purchases makes it,
  // with its purchase check (ctl.writable: true, or why it is not pending).
  const plan = (generatedAt, bundle = buyerBundle, { via = null, writable = () => ctl.writable } = {}) => resolveDemDeliveryBuyerContext(via ? capabilityFor(via) : capability, { operation, listing: published.listing, buyerBundle: bundle, generatedAt, writable });
  const journalStage = async (addr) => { const row = (await journal.entries()).find(([k, v]) => k.startsWith('demo/artifact/') && v?.input?.logicalAddress === addr)?.[1]; return row ? { stage: row.stage, hash: row.input.receiptContentHash, error: row.error ?? null } : null; };
  const accepted = () => harness.chain.wire.record.accepted.length;
  const acceptedFor = (addr) => harness.chain.wire.record.accepted.filter((tx) => tx?.content?.data?.[1]?.metadata?.logicalAddress === addr).length;
  const prompted = (addr) => ctl.prompts.filter((p) => p.addr === addr).length;
  const waitForSellerPrompt = async () => { while (!prompted(ctl.sellerAddr)) await sleep(20); };
  const vetState = async () => (await store.entries()).map(([, v]) => v);
  return { harness, get provider() { return provider; }, get capability() { return capability; }, get journal() { return journal; }, get store() { return store; }, get anchor() { return anchor; },
    get jobId() { return jobId; }, get operation() { return operation; },
    build, restart, switchJob, identity, plan, ctl, seller, buyer, other, buyerBundle, otherBundle, published, journalStage, accepted, acceptedFor, prompted, waitForSellerPrompt, vetState };
}
