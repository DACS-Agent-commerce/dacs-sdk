// a review P1-1 on PR the source change, pinned. A party Vet replay reads the anchored
// record back through anchor.readRetained (the SDK's readAnchoredJson and
// resolveFinalizedArtifact, and the provider's own readback). For an accepted
// but missing seller CREATE that readback may make main's the source change resend: once,
// with the exact original signed bytes (the named closed-access-19-resend
// exception). Over repeated retries, and across a restart, the replay makes
// at most that one resend and never signs a new record.
//
// Fixture chain only, no network; the source and artifact journals are the
// durable SQLite journals the operator uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compositeVerificationAddress, generateCanonicalJobId } from '@kynesyslabs/dacs';
import { startDevnetLiveCompositionTransport } from './helpers/devnet-live-composition-transport.mjs';
import { createDevnetAgreementWalletTransport } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createEphemeralPackagedSeller } from './helpers/native-settlement-consumer-seller.mjs';
import { fixtureIdentityBundle, fixtureListing } from './fixtures/listings.mjs';
import { createOperatorBuyerAccess } from '../src/devnet-demo/buyer-access.mjs';
import { createDevnetDemoArtifactAnchor } from '../src/devnet-demo/artifact-anchor.mjs';
import { createDevnetDemoListingPublisher } from '../src/devnet-demo/listing.mjs';
import { createDevnetDemoAgreementContextProvider } from '../src/devnet-demo/agreement-context.mjs';
import { createDemDeliveryContext, resolveDemDeliveryBuyerContext } from '../src/dacs/dem-delivery-context-consumer.mjs';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { openPartyVetStore } from '../src/devnet-demo/party-vet-store.mjs';
import { DEM_RAIL } from '../src/dacs/listing.mjs';

const envelope=(response)=>({result:200,response,require_reply:false,extra:null});
const statusEnvelope=(response)=>({...envelope(response),extra:''});
const railAuthority=()=>({trustPhase:'PA-1',trustPolicyAcceptsPA1:true,registry:{state:'not-used',entries:[],definitions:[]},inCodeDefinitions:[{railId:DEM_RAIL.railId,railVersion:DEM_RAIL.railVersion,phaseHandler:'pay-dem',governanceAnchoring:'in-code',signatureValid:true}]});

test('a party Vet replay over repeated retries and a restart makes at most the one the source change resend of the original seller CVR bytes and signs nothing new', { timeout: 300000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'party-vet-resend-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = openDurableWalletJournal({ path: join(directory, 'source.sqlite'), mode: 'create' }); t.after(() => source.close());
  const ctl = { sellerAddr: null, lostHash: null, broadcasts: [], prompts: [], signatures: 0 };
  // the source change's lost fixture, aimed at the seller CVR: each broadcast of it is
  // answered as relayed but never applied, so it stays accepted but missing.
  const harness = await startDevnetLiveCompositionTransport({ sourceJournal: source, transportOptions: { inclusionWaitMs: 0 }, rpcResponse: async (body, headers) => {
    const call = body.params?.[0];
    const forward = () => fetch(`${harness.chain.url}/`, { method: 'POST', headers: { 'content-type': 'application/json', identity: headers.identity, signature: headers.signature, timestamp: headers.timestamp }, body: JSON.stringify(body) }).then((response) => response.json());
    if (call?.extra === 'confirmTx') { const answer = await forward(); return { ...answer, response: { data: { reference_block: 0, message: '[Tx Validation] Transaction signature verified\n', ...answer.response.data }, signature: { type: 'ed25519', data: `0x${'11'.repeat(64)}` }, rpc_public_key: { type: 'ed25519', data: `0x${'22'.repeat(32)}` } } }; }
    if (call?.extra === 'broadcastTx') {
      const tx = call.data.response.data.transaction;
      ctl.broadcasts.push({ hash: tx.hash, bytes: JSON.stringify(tx) });
      if (tx.content?.data?.[1]?.metadata?.logicalAddress === ctl.sellerAddr) { ctl.lostHash = tx.hash; return { result: 200, response: { message: 'Transaction relayed to validators' }, require_reply: false, extra: { confirmationBlock: 2 } }; }
    }
    if (call?.message === 'getBlockByNumber' && call.data.blockNumber === 0) { const answer = await fetch(`${harness.chain.url}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((response) => response.json()); answer.extra = ''; return answer; }
    const lost = ctl.lostHash && call?.data?.hash === ctl.lostHash;
    if (lost && call?.message === 'getTransactionStatus') return statusEnvelope({ state: 'unknown' });
    if (lost && call?.message === 'getTxByHash') return { result: 400, response: 'error', require_reply: false, extra: null };
    return undefined;
  } }); t.after(() => harness.close());
  globalThis.location = new URL(harness.origin); globalThis.window ??= globalThis; globalThis.document ??= { baseURI: `${harness.origin}/portal/assets/embedded-wallet/`, currentScript: null };
  const approve = async (request) => { ctl.prompts.push(request.content?.logicalAddress ?? request.content?.artifactKind); return true; };
  const seller = await createEphemeralPackagedSeller({ rpcUrl: `${harness.origin}/portal/api/devnet-native-wallet-rpc`, network: 'demos-devnet', transactionTransport: createDevnetAgreementWalletTransport(harness.capability.profile(harness.origin)), approve }); t.after(() => seller.close());
  const buyer = await createEphemeralPackagedSeller({ network: 'demos-devnet', transactionTransport: createDevnetAgreementWalletTransport(harness.capability.profile(harness.origin)) }); t.after(() => buyer.close());
  const journal = openDurableWalletJournal({ path: join(directory, 'artifacts.sqlite'), mode: 'create' }); t.after(() => journal.close());
  const buyerAccess = createOperatorBuyerAccess({ openBuyerAccess: true });
  const anchor = createDevnetDemoArtifactAnchor({ sourceCapability: harness.capability, journal, walletFactory: seller.walletFactory, network: 'demos-devnet', buyerAccess, signer: { claim: seller.signer.claim, sign: (bytes) => seller.signer.signBytes(bytes) } });
  const { signature: _s, ...listingDraft } = fixtureListing(seller.signer, { listingId: 'party-vet-resend', version: 1, now: Date.now() - 1000, notAfter: Date.now() + 86400000 });
  const published = await createDevnetDemoListingPublisher({ anchor, sign: (bytes) => seller.signer.signBytes(bytes), scanOwnListings: async () => ({ status: 'ok', anchors: [] }), loadRailResolution: railAuthority })(listingDraft);
  // Every SDK readback goes through readRetained; count them.
  let retainedReads = 0;
  const counted = Object.freeze({ ...anchor, readRetained: (input) => { retainedReads += 1; return anchor.readRetained(input); } });
  const resends = []; const stop = harness.capability.onStorageWriteResend((notice) => resends.push(notice)); t.after(stop);
  // A restarted provider opens the party Vet store file again.
  const stores = []; t.after(() => { for (const store of stores) store.close(); });
  const openStore = () => { const store = openPartyVetStore({ path: join(directory, 'seller-party-vet.sqlite') }); stores.push(store); return store; };
  const provider = () => createDevnetDemoAgreementContextProvider({ anchor: counted, store: openStore(), listing: published.listing, buyerAccess, log: () => {},
    wallet: { claim: seller.signer.claim, signBytes: (bytes) => { ctl.signatures += 1; return seller.signer.signBytes(bytes); } } });
  const jobId = generateCanonicalJobId(), buyerBundle = fixtureIdentityBundle(buyer.signer, Date.now() - 2000);
  ctl.sellerAddr = compositeVerificationAddress(jobId, seller.signer.claim);
  const operation = { id: 'pur_party_vet_resend', accountId: 'acct_party_vet_resend', terms: { buyer: { wallet: buyer.signer.address }, protocol: { jobId },
    seller: { claim: seller.signer.claim, payee: seller.signer.address }, listing: { ...published.listingPin }, price: { amount: '1', currency: 'DEM' } } };
  let built = provider();
  const plan = () => resolveDemDeliveryBuyerContext(createDemDeliveryContext({ authority: 'TEST-party-vet-resend', resolveBuyer: built.resolveBuyer, resolveSeller: built.resolveSeller }), { operation, listing: published.listing, buyerBundle, generatedAt: Date.now(), writable: () => true });
  const sellerBytes = () => ctl.broadcasts.filter((entry) => entry.hash === ctl.lostHash).map((entry) => entry.bytes);

  const first = await plan();
  assert.equal(first.disposition, 'indeterminate', JSON.stringify(first));
  assert.ok(ctl.lostHash, 'the seller CVR was broadcast and lost');
  assert.equal(ctl.signatures, 2, 'one buyer and one seller record signature');
  const afterFirst = sellerBytes();
  assert.ok(afterFirst.length >= 1 && afterFirst.length <= 2, `original plus at most one resend (${afterFirst.length})`);
  // Repeated retries, then a restart and more retries: readback only.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt === 2) built = provider();
    const reads = retainedReads, out = await plan();
    assert.equal(out.disposition, 'indeterminate', JSON.stringify(out));
    assert.ok(retainedReads > reads, 'the retry read the records back');
  }
  const all = sellerBytes();
  const state = await stores.at(-1).entries();
  t.diagnostic(JSON.stringify({ sellerCvrBroadcasts: all.length, resendNotices: resends.length, retainedReads, partyVetRecords: state.length, partyVetBytes: state.map(([, value]) => JSON.stringify(value).length) }));
  // This fixture does reach the source change: the original broadcast and its one resend.
  assert.equal(all.length, 2, 'the original and exactly one the source change resend in total');
  assert.ok(all.every((bytes) => bytes === all[0]), 'only the original signed bytes were ever sent');
  assert.equal(resends.length, 1); assert.equal(resends[0].hash, ctl.lostHash);
  assert.equal(ctl.signatures, 2, 'no record was signed again');
  assert.equal(ctl.prompts.filter((entry) => entry === ctl.sellerAddr).length, 1, 'no new seller approval');
  assert.equal(new Set(ctl.broadcasts.map((entry) => entry.hash)).size, 3, 'Listing, buyer CVR and seller CVR: no new transaction');
});
