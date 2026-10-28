// The shipped standalone host on its native path, from payment evidence to
// delivery: startSellerHost with the package's wallet journal over scripted
// wallet primitives and every other operator capability scripted, and the
// package's own native payment evidence consumer reading a scripted in-memory
// Demos node (marked as the fixture node it requires). The host and the agent
// take the evidence anchor and its reconciliation only from one wallet
// journal, so every wallet fault is one of the journal's primitives. The buyer
// proposes, commits, pays and claims over the authenticated HTTP transport.
// Commitment, payment evidence and the Deliverable are signed storage CREATEs
// on that node, each read back through the package's SR-2 adapter.
import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseSync from 'better-sqlite3';
import {testWallet,NOW}from './helpers/protocol-fixture.mjs';
import * as core from '@kynesyslabs/dacs';
import {sellerApi as seller}from './helpers/seller-internal-api.mjs';
import { createDemDeliveryContext } from '../src/dacs/dem-delivery-context-consumer.mjs';
import { createNativeDemDeliveryCapability, provenUnsignedAbsence } from '../src/dacs/native-dem-delivery-consumer.mjs';
import { createNativePaymentEvidenceConsumer, NATIVE_PAYMENT_EVIDENCE } from '../src/dacs/native-payment-evidence-consumer.mjs';
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal, DEMOS_SR2_FIXTURE_CHAIN_IDENTITY } from '../src/dacs/demos-sr2-adapter.mjs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../src/dacs/wallet-transactions.mjs';
import { railSteward } from './helpers/rail-authority-fixture.mjs';
import { SELLER_TRANSPORT_HEADER } from '../src/dacs/seller-transport-auth.mjs';
import { createSessionAdmissionFixture } from './helpers/session-admission-fixture.mjs';
import {finalizedCommitmentReader} from './helpers/finalized-commitment-reader.mjs';
import { sdkRegeneratesSignedCreate } from './helpers/payment-evidence-wallet-sdk.mjs';

const deliveryStaged=!readFileSync(new URL('../src/dacs/seller-agent.mjs',import.meta.url),'utf8').includes('async function runSdkDeliveryReady');
const assertDeliveryStage=(answer,w)=>{if(deliveryStaged){assert.equal(answer.delivery.status,'held');assert.equal(w.effects.deliverySubmit.length,0);}else assert.ok(['held','delivery-ready','delivered'].includes(answer.delivery.status));};
let jobSequence=0;
const NATIVE_FLOW_TIMEOUT_MS=60_000;
const RPC = 'http://127.0.0.1:9/';
const clone = (value) => structuredClone(value);
const demToOs = (amount) => { const [whole, fraction = ''] = amount.split('.'); return (BigInt(whole) * 10n ** 9n + BigInt(fraction.padEnd(9, '0'))).toString(); };

function key(tag){const wallet=testWallet(tag);return{...wallet,sign:wallet.signBytes,signWallet:message=>'0x'+wallet.signBytes(Buffer.from(message)).toString('hex')};}
const identityFor = (party, presentedAt, sessionSeed = 'host-native-delivery') => {
  const unsigned = seller.buildUnsignedIdentityBundle({ address: party.address, presentedAt, sessionSeed });
  return seller.attachIdentityPresentation(unsigned, party.signWallet(unsigned.message));
};
// The buyer's presentation of the challenge the seller host issued (CORE SN-1/SN-3).
const presentChallenge = (party, presentedAt, sessionNonce) => {
  const unsigned = seller.buildUnsignedIdentityBundle({ address: party.address, presentedAt, sessionSeed: 'host-native-delivery' });
  const bundle = { ...unsigned.bundle, sessionNonce }, bundleHash = core.sha256Hex(core.canonicalize(bundle));
  return seller.attachIdentityPresentation({ bundle, bundleHash }, party.signWallet(unsigned.message.replace(unsigned.bundleHash, bundleHash)));
};

// One Demos node: confirmed blocks bound to the fixture chain identity, native
// DEM transfers, signed storage CREATEs and the name index over them.
// A scripted fixture, not node2's answers: node2 answers a genesis read
// (`getBlockByNumber {blockNumber:0}`) and a missing `getTxByHash` with 400,
// its `GET /storage-program` omits `createdByTx`/`interactionTxs`, its blocks
// carry `validation_data: {signatures}`, and its name index shows a program
// only once its block is applied. Build no live test on these shapes.
function demosNode() {
  const ID = DEMOS_SR2_FIXTURE_CHAIN_IDENTITY;
  const blocks = [{ number: 0, status: 'confirmed', hash: ID, content: { timestamp: 0, ordered_transactions: [] }, validation_data: { simulated: true, chainIdentity: ID } }];
  // `nonces`: the last nonce each writer signed; `accountNonces`: the nonce of
  // its last applied transaction (the node's account nonce).
  const txs = new Map(), programs = new Map(), nonces = new Map(), accountNonces = new Map(), creates = [];
  // The name index for a program: `indexDown` does not answer, `indexEmpty`
  // answers no rows, `beforeSearch` runs before it answers. `searches` lists them.
  const faults = { indexDown: () => false, indexEmpty: () => false, beforeSearch: async () => {} }, searches = [];
  // Block time (s): 2 s after the previous block and, as on a real chain, never
  // before the wall time the transaction lands at. A block stamped behind it
  // would predate what the host observed before sending the transaction (the
  // proposal's admission, the delivery's validation): on a busy machine the
  // commitment block then precedes phase 0 of the SessionRecord, and the SDK
  // delivery runner refuses the record as not monotonic.
  let clock = Math.ceil(NOW / 1000);
  const include = (tx) => {
    clock = Math.max(clock + 2, Math.ceil(NOW / 1000));
    const number = blocks.length;
    blocks.push({ number, status: 'confirmed', hash: core.sha256Hex(`TEST-block:${number}:${tx.hash}`), content: { timestamp: clock, ordered_transactions: [tx.hash] },
      validation_data: { simulated: true, chainIdentity: ID } });
    // As node 61b8e75 keeps an executed transaction: each execution edit the signer left blank names it.
    const executed = { ...clone(tx), status: 'confirmed', blockNumber: number };
    for (const edit of executed.content.gcr_edits ?? []) if (edit.txhash === '') edit.txhash = tx.hash;
    txs.set(tx.hash, executed);
  };
  const nodeCall = (message, data) => {
    switch (message) {
      case 'getBlockByNumber': return clone(blocks[data.blockNumber] ?? null);
      case 'getTransactionStatus': { const tx = txs.get(String(data.hash).toLowerCase()); return tx ? { state: 'included', blockNumber: tx.blockNumber } : { state: 'not-found' }; }
      case 'getTxByHash': return clone(txs.get(String(data.hash).toLowerCase()) ?? null);
      case 'searchStoragePrograms': return faults.indexEmpty(data.query) ? []
        : [...programs.values()].filter((p) => p.programName === data.query).map(({ storageAddress, programName }) => ({ storageAddress, programName }));
      default: return undefined;
    }
  };
  const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-dacs-simulation': 'fixture' } });
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const program = /^\/storage-program\/(stor-[0-9a-f]{40})$/.exec(pathname);
    if ((init.method ?? 'GET') === 'GET' && program) return programs.has(program[1]) ? answer(200, clone(programs.get(program[1]))) : answer(404, { success: false });
    if (init.method === 'POST' && pathname === '/') {
      const call = JSON.parse(init.body).params[0];
      if (call.message === 'searchStoragePrograms') {
        searches.push(call.data.query);
        await faults.beforeSearch(call.data.query);
        if (faults.indexDown(call.data.query)) return answer(503, { error: 'TEST name index unavailable' });
      }
      if(call.message==='getTxByHash'&&faults.transactionDown?.(call.data.hash))return answer(503,{error:'TEST transaction read unavailable'});
      const response = nodeCall(call.message, call.data ?? {});
      return answer(200, response === undefined ? { result: 400, response: 'unknown method' } : { result: 200, response });
    }
    return answer(404, { error: 'not found' });
  };
  // The buyer's native DEM transfer.
  const pay = ({ from, to, amountOs }) => {
    const nonce=(nonces.get(from)??0)+1;nonces.set(from,nonce);
    const content = { type: 'native', from, from_ed25519_address: from, to, amount: amountOs, data: ['native', { nativeOperation: 'send', args: [to, amountOs] }], nonce, timestamp: NOW };
    const tx = { hash: core.sha256Hex(JSON.stringify(content)), content, signature: { type: 'ed25519', data: 'TEST-buyer-transfer' } };
    include(tx);accountNonces.set(from,nonce);
    return tx.hash;
  };
  // A storage CREATE the writer's wallet signed (Demos: ed25519 over the tx hash).
  // `land: false` signs it without the node applying it (a dropped submission);
  // `rebroadcast(hash)` applies a signed CREATE the node has not applied, once,
  // and only while its nonce is above its writer's account nonce: as on node
  // 61b8e75 (validateTransaction, mempool), a transaction whose nonce a later
  // write of the same account has reached can never be included.
  const pending = new Map();
  const rebroadcast = (hash) => {
    const signed = pending.get(hash);
    if (!signed || signed.nonce <= (accountNonces.get(signed.owner) ?? 0)) return;
    pending.delete(hash);
    signed.apply();
  };
  const create = (writer, { logicalAddress, artifact, artifactKind, deliveryBinding }, { land = true } = {}) => {
    const owner = writer.address, programName = core.logicalToStorageProgramName(logicalAddress), nonce = (nonces.get(owner) ?? 0) + 1;
    nonces.set(owner, nonce);
    const storageAddress = deriveStorageAddress(owner, programName, nonce, '');
    const { content } = buildStorageProgramCreatePayload({ from: owner, storageAddress, programName, logicalAddress, signedListing: clone(artifact), nonce, timestamp: NOW });
    const metadata = { logicalAddress, contentHash: (artifactKind === 'Deliverable' ? core.sha256Hex(core.canonicalize(artifact)) : core.contentHash(artifact)), envelopeHash: core.sha256Hex(core.canonicalize(artifact)), artifactKind, ...(deliveryBinding ? { deliveryBinding: clone(deliveryBinding) } : {}) };
    content.data[1].metadata = metadata;
    content.from_ed25519_address = owner;
    // What demosdk 4.0.16 sign adds to a storage CREATE (checked against the SDK below): the node's fee, and the
    // execution edits its GCRGeneration writes before the hash exists: the storage fee burn (1 DEM per started
    // 10240 bytes of the program's JSON), the storage program, the gas burn and the nonce increment.
    content.transaction_fee = { network_fee: 2, rpc_fee: 3, additional_fee: 0, rpc_address: null };
    const op = content.data[1], storageFee = Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(op.data)) / 10_240));
    content.gcr_edits = [{ type: 'balance', operation: 'remove', isRollback: false, account: owner, txhash: '', amount: storageFee },
      { type: 'storageProgram', target: storageAddress, isRollback: false, txhash: '', context: { operation: 'CREATE_STORAGE_PROGRAM', sender: owner, data: { variables: clone(op), metadata: clone(op.metadata) } } },
      { type: 'balance', account: owner, operation: 'remove', amount: 1, txhash: '', isRollback: false }, { type: 'nonce', operation: 'add', account: owner, amount: 1, txhash: '', isRollback: false }];
    const hash = core.sha256Hex(JSON.stringify(content)), signed = { hash, content, signature: { type: 'ed25519', data: writer.signWallet(hash) } };
    pending.set(hash, { owner, nonce, apply: () => {
      include(signed);
      accountNonces.set(owner, nonce);
      programs.set(storageAddress, { success: true, storageAddress, owner, programName, data: clone(artifact), metadata: clone(metadata), createdByTx: hash, interactionTxs: [hash] });
      creates.push({ logicalAddress, artifactKind, hash });
    } });
    if (land) rebroadcast(hash);
    return clone(signed);
  };
  const reader = createDemosSr2Adapter({ rpcUrl: RPC, journal: createInMemoryDemosSr2Journal(), fetchImpl, now:()=>faults.observedAt??Date.now() });
  // A transfer's block and inclusion time (ms), as the pay-dem observer reads them.
  const inclusion = (hash) => { const { blockNumber } = txs.get(hash); return { blockNumber, includedAt: blocks[blockNumber].content.timestamp * 1000 }; };
  // The wallet's chain reads: its account nonce, and whether a transaction was
  // applied (this node keeps no mempool, so anything else is absent).
  const accountNonce = (owner) => accountNonces.get(owner) ?? 0;
  const transactionState = (hash) => (txs.has(String(hash).toLowerCase()) ? 'applied' : 'absent');
  return { fetchImpl, pay, create, rebroadcast, reader, creates, programs, faults, searches, inclusion, accountNonce, transactionState, blockHeight: () => blocks.length - 1, latestBlockMs: () => blocks.at(-1).content.timestamp * 1000 };
}

// The application's Deliverable producer: a report bound to the job, its
// Agreement and its settlement; `change` replaces any of its fields.
const report = (change = {}) => ({ agreement, settlementId }) => ({ reportVersion: '1', kind: 'TEST-host-native-delivery/report', jobId: agreement.jobId,
  agreementHash: core.contentHash(agreement), settlementId, body: ['TEST report delivered by the standalone host.'], ...change });

// `schemaUrl: false`: the Listing's deliverable names no schema, so the SDK
// runs no schema verifier over the prepared Deliverable.
// The seller wallet is the package's createPaymentEvidenceWalletJournal over
// the wallet's sign, broadcast and chain-read primitives on this node; a plain
// Demos wallet signs a new CREATE whenever it is asked (the node checks only
// the nonce-derived storage address, so a second CREATE under one name lands).
// `faults.signCreate`: 'throw' before signing; `faults.broadcast`: 'drop' (the
// node never applies it), 'lost' (applied, then the answer is lost) or 'other'
// (the node applies instead a seller-signed CREATE of evidence naming another
// transfer, as another tool holding the seller's key could write);
// `faults.readAccountNonce`: 'throw'. `restartWallet()` reopens the journal.
// The host requires the journal's question (reconcilePaymentEvidence);
// `reconcile: false` leaves it out. `projectionReader: false` composes the
// evidence consumer as the README does, without a reader of its own.
// `sellerPresentation`: 'session' gives the Vet context a fresh seller
// presentation of the Listing identity, as the package's Vet provider makes,
// 'forged' one not signed by the seller. `faults.sign`: 'throw-evidence' fails
// the seller signer's next SettlementEvidence signature; `faults.deliverySubmit`: 'fail' refuses
// before signing, 'land-lose-lock' lands the Deliverable and then the job's
// seller-state lock row is lost, so nothing after it is recorded; 'sign-then-lose'
// signs and keeps the CREATE, then fails before it is broadcast.
async function world(t, { deliveryJournal = false, deliverableProducer = null, schemaUrl = true, reconcile = true, projectionReader = true, sellerPresentation = null, deliverableExtension = {}, deliverySchemaVerifier = undefined, maxJobs = 10000, deliveryEvidenceEnabled = false, compatibilityObserver = true, idempotentArtifacts = true, omitExpectedSize = false, buyerAccessOptions = { openBuyerAccess: true } } = {}) {
  const sellerKey = key(17), buyerKey = key(12), now = NOW, steward = railSteward(), node = demosNode();
  // The host's and the buyer client's clock: wall time, never behind the
  // node's latest block (the node stamps its blocks at least 2 s apart, so
  // they can run ahead of wall time).
  const clock = () => Math.max(NOW, node.latestBlockMs());
  const admission = createSessionAdmissionFixture({ seller: sellerKey, buyer: buyerKey,now:clock });
  const draft = seller.buildListingDraft({ identityBundle: identityFor(sellerKey, now - 1000), displayName: 'Native host seller', publicEndpoint: 'https://seller.invalid/agent',
    listingId: 'host-native-delivery', listingVersion: 1, title: 'Native host report', description: 'Payment evidence to delivery through the standalone host.',
    category: 'services.market-report', tags: ['native'], priceDem: '2.5', notBefore: now - 60000 });
  if (!schemaUrl) delete draft.offering.deliverable.schemaUrl;
  // All binding strings have fixed canonical lengths. Declare the exact
  // output size for this test producer unless exercising the unsupported path.
  const sample = (deliverableProducer ?? report())({ agreement: { jobId: '0'.repeat(26) }, listing: draft, settlementId: `demos:${'0'.repeat(64)}` });
  if (!omitExpectedSize) draft.offering.deliverable.expectedSizeBytes = sample && typeof sample.then !== 'function'
    ? Buffer.byteLength(core.canonicalize(sample)) : 1024;
  Object.assign(draft.offering.deliverable, deliverableExtension);
  const listing = seller.attachListingSignature(draft, sellerKey.signWallet(seller.listingSigningMessage(draft))), pin = seller.listingPin(listing);
  // One buyer presentation per job, of the challenge the host issued for it
  // (CORE SN-1..SN-4: a session nonce admits one session).
  const buyerBundles = new Map();
  const buyerBundleFor = (jobId) => {
    if (!buyerBundles.has(jobId)) buyerBundles.set(jobId, presentChallenge(buyerKey, now, host.issueSessionChallenge({ jobId, buyer: buyerKey.claim }).sessionNonce));
    return buyerBundles.get(jobId);
  };
  // What each operator capability did. `faults` script the next answers;
  // `beforeDeliveryReconcile` runs before the delivery capability reconciles.
  // `effects.signCreate` lists the address of each signature asked of the
  // wallet, `signed` the hash of each it gave, `broadcast` each sent payload.
  const effects = { deliverySubmit: [], published: [], signCreate: [], signed: [], broadcast: [], componentSigns: [], deliverySignCreate: [], deliverySigned: [], deliveryBroadcast: [] };
  const faults = { deliverySubmit: [], deliverySignCreate: [], deliveryBroadcast: [], deliveryRead: [], deliveryReconcile: [], signCreate: [], broadcast: [], readAccountNonce: [], sign: [], beforeDeliveryReconcile: async () => {}, agreementRead: [], artifactPublish: [], artifactRead: [] };
  const evidenceBytes = (bytes) => Buffer.from(bytes).toString('utf8').startsWith(core.ARTIFACT_SEPARATORS.SettlementEvidence);
  const sellerSigner = { claim: sellerKey.claim, sign: (bytes) => {
    effects.componentSigns.push(Buffer.from(bytes).toString('utf8'));
    if (faults.sign[0] === 'throw-evidence' && evidenceBytes(bytes)) { faults.sign.shift(); throw new Error('TEST the seller signer failed'); }
    return sellerKey.sign(bytes);
  } };
  // A seller bundle for the session: the Listing identity presented afresh.
  const sessionSeller = (signerKey) => {
    const { presentation: _publication, ...identity } = listing.seller.identity;
    const bundle = { ...identity, presentedAt: now, sessionNonce: core.sha256Hex('TEST seller session') };
    const signature = signerKey.sign(Buffer.from(`dacs-bundle-presentation:v1:${core.identityBundleHash(bundle)}`)).toString('base64url');
    return { ...bundle, presentation: { kind: 'per-claim', signatures: [{ ref: sellerKey.claim, signature }] } };
  };

  // The operator's Vet context for each job: references to the
  // counterparty-verified records its session admission keeps (DACS-2 §7.7.2).
  const inputs = new Map();
  const vettedInput = async (jobId) => {
    if (!inputs.has(jobId)) {
      const buyerBundle = buyerBundleFor(jobId), input = seller.agreementInput({ jobId, listing, buyerBundle, generatedAt: now });
      const sellerBundle = sellerPresentation ? sessionSeller(sellerPresentation === 'forged' ? buyerKey : sellerKey) : listing.seller.identity;
      inputs.set(jobId, { ...input, buyer: { ...input.buyer, vetRecordRef: await admission.vetRecord(jobId, buyerKey.claim, buyerBundle, { requirement: listing.buyerRequirement }) },
        seller: { identityBundle: sellerBundle, vetRecordRef: await admission.vetRecord(jobId, sellerKey.claim, sellerBundle, { requirement: listing.buyerRequirement }) } });
    }
    return clone(inputs.get(jobId));
  };
  // The buyer's Agreement CREATEs, read back by the seller.
  const agreements = new Map();
  const agreementAnchor = { source: 'TEST-host-native-delivery/agreement',
    readAgreement: async ({ logicalAddress }) => {
      if (faults.agreementRead.shift() === 'throw') throw new Error('TEST Agreement reader unavailable');
      return (agreements.has(logicalAddress)
      ? { disposition: 'present', artifact: clone(agreements.get(logicalAddress)), ref: { anchor: { kind: 'storage-program', locator: logicalAddress }, contentHash: core.contentHash(agreements.get(logicalAddress)) },
        native: { source: 'TEST-host-native-delivery/agreement', evidenceMode: 'TEST-scripted', nativeAddress: 'TEST-native-agreement', txRef: { kind: 'demos', txHash: 'c3'.repeat(32), blockNumber: 1 } } }
      : { disposition: 'absent', reason: 'TEST not anchored' }); } };
  // Seller CREATEs, by logical address; each is read back through the SR-2 adapter.
  const signedCreates = new Map(), written = new Map();
  const finalized=finalizedCommitmentReader(node.reader,sellerKey);
  const readBack = async (logicalAddress, artifactKind, deliveryBinding) => {
    const signed = signedCreates.get(logicalAddress);
    if (!signed) return { status: 'absent', reason: 'TEST no seller CREATE at this address' };
    const read = await (artifactKind==='FinalityCommitmentRecord'?finalized:node.reader).read(logicalAddress, { expectedWriter: sellerKey.claim, expectedArtifactKind: artifactKind, signedProjection: clone(signed),
      ...(deliveryBinding ? { expectedDeliveryBinding: deliveryBinding } : {}) });
    if (read.status !== 'present') return { status: read.status, reason: 'TEST seller CREATE did not read back' };
    return { status: 'present', artifact: read.artifact, receipt: read.receipt, txRef: { kind: 'demos', txHash: signed.hash, blockNumber: read.demosEvidence.blockNumber },
      signedProjection: clone(signed), demosEvidence: read.demosEvidence };
  };
  const recordFinality=(logicalAddress,artifact,artifactKind)=>{if(artifactKind==='FinalityCommitmentRecord'){const signedProjection=signedCreates.get(logicalAddress),included=node.inclusion(signedProjection.hash);finalized.record({logicalAddress,artifact,signedProjection,blockRef:{id:core.sha256Hex('TEST-finalized-block:'+included.blockNumber),height:String(included.blockNumber),timestamp:included.includedAt}});}};
  const writeOnce = (logicalAddress, artifact, artifactKind, deliveryBinding) => {
    if (!signedCreates.has(logicalAddress)) {
      signedCreates.set(logicalAddress, node.create(sellerKey, { logicalAddress, artifact, artifactKind, deliveryBinding }));
      written.set(logicalAddress, clone(artifact));
      recordFinality(logicalAddress,artifact,artifactKind);
    }
  };
  const artifactAnchor = { writer: sellerKey.claim, source: 'TEST-host-native-delivery/artifacts',
    publish: async ({ logicalAddress, artifact, artifactKind, authorize }) => {
      // A plain wallet creates a new program on every call. Exercise that
      // operator contract too, so the seller must prevent a duplicate call.
      if (!idempotentArtifacts) {
        if (authorize && authorize() !== true) throw new Error('TEST the seller withdrew this write');
        effects.published.push(artifactKind);
        signedCreates.set(logicalAddress, node.create(sellerKey, { logicalAddress, artifact, artifactKind }));
        written.set(logicalAddress, clone(artifact));
        recordFinality(logicalAddress,artifact,artifactKind);
        if (faults.artifactPublish.shift() === artifactKind + ':land-throw') throw new Error('TEST publication response lost after CREATE');
        return readBack(logicalAddress, artifactKind);
      }
      if (faults.artifactPublish[0] === artifactKind + ':land-throw') { faults.artifactPublish.shift(); effects.published.push(artifactKind); writeOnce(logicalAddress, artifact, artifactKind); throw new Error('TEST publication response lost after CREATE'); }
      if (faults.artifactPublish[0] === artifactKind) { faults.artifactPublish.shift(); throw new Error('TEST publisher unavailable before intent'); }
      if (!signedCreates.has(logicalAddress)) {
        if (authorize && authorize() !== true) throw new Error('TEST the seller withdrew this write');
        effects.published.push(artifactKind);
        writeOnce(logicalAddress, artifact, artifactKind);
      }
      return readBack(logicalAddress, artifactKind);
    },
    readRetained: async ({ logicalAddress, artifactKind }) => {
      const fault = faults.artifactRead.shift();
      if (fault === 'unknown') return { status: 'indeterminate', reason: 'TEST uncertain retained CREATE' };
      if (fault === 'absent') return { status: 'absent', reason: 'TEST lagging name index' };
      if (fault === 'unbranded') return { ...provenUnsignedAbsence('TEST serialized proof is not authoritative') };
      let read = await readBack(logicalAddress, artifactKind);
      if(artifactKind==='SettlementEvidence'&&read.status==='present'&&faults.evidenceRead)read=faults.evidenceRead(clone(read));
      return read.status === 'absent' && !signedCreates.has(logicalAddress) ? provenUnsignedAbsence(read.reason) : read;
    },
    verifyReceipt: async ({ logicalAddress, artifact, artifactKind, receipt, signedProjection }) =>
      (artifactKind==='FinalityCommitmentRecord'?finalized:node.reader).verifyReceipt({ receipt, logicalAddress, artifact, expectedWriter: sellerKey.claim, artifactKind, signedProjection }),
  };
  // The seller wallet's payment-evidence journal (DACS-4 PC-7(b)).
  const walletDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'seller-host-wallet-')));
  // Another tool with the seller's key lands its own CREATE at the address:
  // seller-signed evidence naming another transfer.
  const landOther = async (signed) => {
    const op = signed.content.data[1], logicalAddress = op.metadata.logicalAddress;
    const { signature: _signature, ...unsigned } = clone(op.data);
    unsigned.paymentTxRefs = [{ ...unsigned.paymentTxRefs[0], txHash: 'd4'.repeat(32) }];
    const artifact = await core.signComponentArtifact(unsigned, core.ARTIFACT_SEPARATORS.SettlementEvidence, { algorithm: 'ed25519', signer: sellerKey.claim, sign: sellerKey.sign });
    signedCreates.set(logicalAddress, node.create(sellerKey, { logicalAddress, artifact, artifactKind: 'SettlementEvidence' }));
    written.set(logicalAddress, clone(artifact));
  };
  const openJournal = (file = 'wallet-journal.sqlite') => seller.createPaymentEvidenceWalletJournal({ path: join(walletDirectory, file),
    signCreate: async ({ logicalAddress, artifact, artifactKind }) => {
      effects.signCreate.push(logicalAddress);
      const fault=faults.signCreate.shift();
      if (fault === 'throw') throw Object.assign(new Error('TEST wallet failed before signing'), { code: 'TEST-wallet-failed' });
      if (fault === 'invalid') return {signedTransaction:'TEST invalid transaction',txHash:'e'.repeat(64),nonce:1};
      const signed = node.create(sellerKey, { logicalAddress, artifact, artifactKind }, { land: false });
      signedCreates.set(logicalAddress, signed); written.set(logicalAddress, clone(artifact)); effects.signed.push(signed.hash);
      return { signedTransaction: JSON.stringify(signed), txHash: signed.hash, nonce: signed.content.nonce };
    },
    readAccountNonce: async () => {
      if (faults.readAccountNonce.shift() === 'throw') throw new Error('TEST account nonce read failed');
      return { nonce: node.accountNonce(sellerKey.address), blockHeight: node.blockHeight() };
    },
    readTransactionState: async ({ txHash }) => ({ state: node.transactionState(txHash), checkedThroughBlock: node.blockHeight() }),
    broadcast: async ({ signedTransaction, txHash }) => {
      effects.broadcast.push(signedTransaction);
      const fault = faults.broadcast.shift();
      if (fault === 'drop') return;
      if (fault === 'other') return landOther(JSON.parse(signedTransaction));
      if (JSON.parse(signedTransaction).hash === txHash) node.rebroadcast(txHash);
      if (fault === 'lost') throw new Error('TEST broadcast answer lost after the node applied it');
    } });
  let journal = openJournal();
  // Reopens the wallet's journal: the host started after it anchors with the new one.
  const restartWallet = () => { journal.close(); journal = openJournal(); if (deliveryJournalWallet) replaceDeliveryWallet(); };
  // Another journal file (the earlier one lost, moved or misconfigured).
  const replaceWallet = (file) => { journal.close(); journal = openJournal(file); };
  const evidenceConsumer = (anchorEvidence) => createNativePaymentEvidenceConsumer({ rpcUrl: RPC, fetchImpl: node.fetchImpl, anchorEvidence,
    ...(projectionReader ? { readSignedProjection: async ({ logicalAddress }) => (signedCreates.has(logicalAddress) ? clone(signedCreates.get(logicalAddress)) : undefined) } : {}) });
  const demDeliveryContext = createDemDeliveryContext({ authority: 'TEST-host-native-delivery',
    resolveBuyer: async () => { throw new Error('TEST the buyer resolver is not the seller\'s'); },
    resolveSeller: async ({ jobId }) => {
      const input = await vettedInput(jobId);
      // One requirement invocation per Vet record the Agreement references,
      // each naming the evaluated party's counterparty as verifier.
      const invocation = (party, claim, verifier) => ({ vetRecordRef: input[party].vetRecordRef, evaluatedParty: claim, requirement: clone(listing.buyerRequirement),
        verifier, freshness: [], dealSpecific: [] });
      return { disposition: 'present', value: { input, vetRequirements: [invocation('buyer', buyerKey.claim, sellerKey.claim), invocation('seller', sellerKey.claim, buyerKey.claim)] } };
    } });
  // The seller's Deliverable CREATE and its public readback.
  const deliverable = async (input) => readBack(input.logicalAddress, 'Deliverable', input.deliveryBinding);
  // The seller wallet's Deliverable journal (`deliveryJournal: true`), over the
  // same scripted node. Its `submit` is the capability's, its `reconcile` the
  // host's `reconcileDeliverableCreate`; the capability's reader then returns no
  // proof of its own, so only the journal's answer can authorize a new signature.
  // `faults.deliverySignCreate`: 'throw' before signing; `faults.deliveryBroadcast`:
  // 'throw' (after signing, nothing broadcast), 'drop' (the node never applies it)
  // or 'lost' (applied, then the answer is lost); `faults.deliveryRead`: 'throw'
  // (the read failed) or 'name-index-miss'/'native-address-miss' (the adapter's
  // complete miss, thrown with its observation); `faults.deliveryReconcile`:
  // the same values thrown by the capability's reconcile.
  const openDeliveryJournal = (file = 'delivery-wallet-journal.sqlite') => seller.createDeliverableWalletJournal({ path: join(walletDirectory, file),
    signCreate: async ({ logicalAddress, artifact, artifactKind, deliveryBinding }) => {
      effects.deliverySignCreate.push(logicalAddress);
      if (faults.deliverySignCreate.shift() === 'throw') throw new Error('TEST delivery wallet failed before signing');
      const signed = node.create(sellerKey, { logicalAddress, artifact, artifactKind, deliveryBinding }, { land: false });
      signedCreates.set(logicalAddress, signed); written.set(logicalAddress, clone(artifact)); effects.deliverySigned.push(signed.hash);
      return { signedTransaction: JSON.stringify(signed), txHash: signed.hash, nonce: signed.content.nonce };
    },
    readAccountNonce: async () => ({ nonce: node.accountNonce(sellerKey.address), blockHeight: node.blockHeight() }),
    readTransactionState: async ({ txHash }) => ({ state: node.transactionState(txHash), checkedThroughBlock: node.blockHeight() }),
    broadcast: async ({ signedTransaction, txHash }) => {
      effects.deliveryBroadcast.push(signedTransaction);
      const fault = faults.deliveryBroadcast.shift();
      if (fault === 'throw') throw new Error('TEST delivery broadcast failed');
      if (fault !== 'drop') node.rebroadcast(txHash);
      if (fault === 'lost') throw new Error('TEST delivery broadcast answer lost after the node applied it');
    } });
  let deliveryJournalWallet = deliveryJournal ? openDeliveryJournal() : null;
  const replaceDeliveryWallet = (file) => { deliveryJournalWallet.close(); deliveryJournalWallet = openDeliveryJournal(file); };
  // A new capability each time, over the wallet's current journal (the host
  // takes the journal's `submit` and `reconcile` as a pair).
  const deliveryCapability = () => createNativeDemDeliveryCapability({ authority: 'TEST-host-native-delivery',
    submit: deliveryJournalWallet ? deliveryJournalWallet.submit : async (input) => {
      effects.deliverySubmit.push(input.logicalAddress);
      const fault = faults.deliverySubmit.shift();
      if (fault === 'fail') throw new Error('TEST delivery wallet refused before signing');
      // Signed and kept, then the answer is lost before anything is broadcast.
      if (fault === 'sign-then-lose') { signedCreates.set(input.logicalAddress, node.create(sellerKey, { logicalAddress: input.logicalAddress, artifact: input.report, artifactKind: 'Deliverable', deliveryBinding: input.deliveryBinding }, { land: false })); throw new Error('TEST delivery wallet failed after signing'); }
      writeOnce(input.logicalAddress, input.report, 'Deliverable', input.deliveryBinding);
      if (fault === 'land-lose-lock') loseJobLock(input.logicalAddress.slice('dacs4:deliverable:'.length));
      return { status: 'accepted', reconciliationId: signedCreates.get(input.logicalAddress).hash };
    },
    reconcile: async (input) => {
      await faults.beforeDeliveryReconcile();
      if (Array.isArray(faults.deliveryReconcile)) {
        const fault = faults.deliveryReconcile.shift();
        if (fault === 'throw') throw new Error('TEST delivery reconcile unavailable');
        if (fault === 'name-index-miss' || fault === 'native-address-miss') throw Object.assign(new Error(`TEST delivery reconcile missed: ${fault}`), { observation: fault });
      }
      const read = await deliverable(input);
      return read.status === 'present' ? { status: 'complete', reconciliationId: read.receipt.transactionRef.value, observedAt: read.receipt.blockRef.timestamp } : { status: 'absent', reason: read.reason };
    },
    // The capability's contract (README): a reader that kept no signed CREATE
    // for the address returns the proven unsigned absence; a miss for a CREATE
    // it did sign (a lagging index, an unbroadcast one) is a plain absence. With
    // the journal, the reader keeps no CREATE of its own and reports plain absence.
    read: async (input) => {
      if (Array.isArray(faults.deliveryRead)) {
        const fault = faults.deliveryRead.shift();
        if (fault === 'throw') throw new Error('TEST delivery node unreachable');
        // The SR-2 adapter's complete miss: an error the node's name index or
        // native-address search reported, not a failure to ask (CORE §5.1).
        if (fault === 'name-index-miss' || fault === 'native-address-miss') throw Object.assign(new Error(`TEST delivery read missed: ${fault}`), { observation: fault });
      }
      const read = await deliverable(input);
      if(read.status==='present'&&typeof faults.deliveryRead==='function')return faults.deliveryRead(clone(read));
      return read.status === 'absent' && !signedCreates.has(input.logicalAddress) && !deliveryJournalWallet ? provenUnsignedAbsence(read.reason) : read;
    },
    verifyReceipt: async ({ logicalAddress, report, receipt, receiptContentHash, deliveryBinding, signedProjection }) => node.reader.verifyReceipt({ receipt, logicalAddress, artifact: report,
      expectedWriter: sellerKey.claim, artifactKind: 'Deliverable', deliveryBinding, receiptContentHash, signedProjection: signedProjection ?? clone(signedCreates.get(logicalAddress)) }),
  });
  const producer = deliverableProducer ?? report();

  const dataDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'seller-host-native-')));
  // The job's seller-state lock row is lost (a raw DELETE): its holder records nothing more.
  const loseJobLock = (jobId) => { const db = new DatabaseSync(join(dataDirectory, 'seller', 'seller-state.sqlite')); try { db.prepare('DELETE FROM seller_locks WHERE job=?').run(jobId); } finally { db.close(); } };
  const rails = { authority: steward.railAuthority() };
  const hosts = [];
  t.after(async () => {try{for (const host of hosts) await host.close();}finally{journal.close();deliveryJournalWallet?.close();rmSync(dataDirectory,{recursive:true,force:true});rmSync(walletDirectory,{recursive:true,force:true});} });
  const capabilities = () => ({ signer: sellerSigner, listing,
    buyerAccess: seller.createOperatorBuyerAccess(buyerAccessOptions), agreementAnchor, deliverableProducer: producer, maxJobs, deliveryEvidenceEnabled,
    deliverySchemaVerifier: deliverySchemaVerifier ?? { schemaUrl: listing.offering.deliverable.schemaUrl, verify: ({ cleartextPayload: p }) => ({ disposition: p.reportVersion === '1' && typeof p.kind === 'string' && Array.isArray(p.body) && p.body.every(v => typeof v === 'string') ? 'valid' : 'invalid' }) },
    ...(compatibilityObserver ? { observeDemosTransfer: async () => { throw new Error('TEST the native profile observes transfers through native payment evidence'); } } : {}),
    nativePaymentEvidence: evidenceConsumer(journal.anchorEvidence), demDeliveryContext, nativeDemDelivery: deliveryCapability(), railAuthority: rails.authority,
    sessionAdmission: admission.sessionAdmission, now: clock, ...(reconcile ? { reconcilePaymentEvidence: journal.reconcilePaymentEvidence } : {}),
    ...(deliveryJournalWallet ? { reconcileDeliverableCreate: deliveryJournalWallet.reconcile } : {}) });
  const start = async () => {
    const host = await seller.startSellerHost({ ...capabilities(), dataDirectory, artifactAnchor });
    hosts.push(host);
    return host;
  };
  let host = await start();

  // One buyer purchase: the buyer signs, finalizes and anchors the Agreement,
  // asks the seller to commit, and pays the Agreement's payee.
  const purchase = async ({ commit = true, expectSigned = true } = {}) => {
    const jobId = '01J8N4YV7YVYQ4DB7M8T'+String(++jobSequence).padStart(6,'0');
    const plan = core.createFixedPriceAgreementSigningPlan(core.deriveFixedPriceAgreement(await vettedInput(jobId)));
    const buyerContribution = await core.createFixedPriceAgreementSignatureContribution(plan, 'buyer', { party: buyerKey.claim, algorithm: 'ed25519', sign: buyerKey.sign });
    const material = { proposalVersion: '1', plan, buyerContribution }, proposal = { ...material, proposalHash: core.sha256Hex(core.canonicalize(material)) };
    const transportIdentity = { jobId, planHash: plan.planHash, agreementHash: plan.agreementHash, buyer: buyerKey.claim, seller: sellerKey.claim, proposalHash: proposal.proposalHash };
    const client = () => seller.createSellerAgentClient({ url: host.url, timeoutMs:NATIVE_FLOW_TIMEOUT_MS, authentication: seller.createSellerTransportClientAuth({
      buyerSigner: { claim: buyerKey.claim, sign: buyerKey.sign }, seller: sellerKey.claim, resolveJob: () => ({ listingPin: pin, agreementHash: plan.agreementHash }), now: clock }) });
    const answer = await client().propose({ proposal, transportIdentity, buyerIdentityBundle: buyerBundleFor(jobId) });
    if (!expectSigned) return answer;
    assert.equal(answer.disposition, 'complete', `the seller signs the vetted Agreement: ${JSON.stringify(answer)}`);
    const agreement = await core.finalizeFixedPriceAgreementContributions(plan, [buyerContribution, answer.contribution], seller.contributionVerifier);
    agreements.set(core.fixedPriceAgreementLogicalAddress(jobId), agreement);
    if (commit) assert.equal((await client().commit(jobId)).status, 'committed');
    const payout = agreement.terms.payoutBindings[0], amountOs = demToOs(agreement.terms.price.amount);
    return { jobId, agreement, agreementHash: plan.agreementHash, transportIdentity, payout, amountOs, client,
      pay: () => node.pay({ from: buyerKey.address, to: payout.payeeAddress, amountOs }),
      claim: async (txHash) => { try { return await client().submitPayment({ jobId, txHash, payerPayingKey: buyerKey.claim, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE }); }
        catch (error) { return { error: error.code, status: error.status, causeCode:error.causeCode }; } } };
  };
  const restart = async () => { await host.close(); hosts.splice(hosts.indexOf(host), 1); host = await start(); };
  // The operator's read-only view of a job's retained session (durableSessionOf),
  // read with the host stopped, from the host's own durable state.
  const retainedSession = async (jobId) => {
    await host.close(); hosts.splice(hosts.indexOf(host), 1);
    const agent = await seller.createSellerAgent({ ...capabilities(), durableDirectory: join(dataDirectory, 'seller'), nativeArtifactAnchor: artifactAnchor });
    try { return agent.durableSessionOf(jobId); } finally { agent.close(); }
  };
  // A host process that died in the middle of a buyer's payment claim: its
  // transport journal reserved the claim (a fresh nonce for the same effect)
  // and never finished it. Left with the host stopped, through the store's
  // own reserve, then the host starts again.
  const crashMidClaim = async (p, txHash) => {
    await host.close(); hosts.splice(hosts.indexOf(host), 1);
    const body = { jobId: p.jobId, txHash, payerPayingKey: buyerKey.claim, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE };
    const signed = await seller.createSellerTransportClientAuth({ buyerSigner: { claim: buyerKey.claim, sign: buyerKey.sign }, seller: sellerKey.claim,
      resolveJob: () => ({ listingPin: pin, agreementHash: p.agreementHash }), now: clock }).request('/dacs/v1/payments', body, JSON.stringify(body));
    const store = seller.createSellerTransportStore({ path: join(dataDirectory, 'transport', 'transport.sqlite'), now: clock });
    try {
      const request = seller.createSellerTransportServerAuth({ sellerSigner: { claim: sellerKey.claim, sign: sellerKey.sign }, listingPin: pin, store, now: clock }).readRequest(signed.header);
      assert.equal(store.reserve(request, body).disposition, 'perform', 'the claim is reserved, as a running request is');
    } finally { store.close(); }
    host = await start();
  };
  // startSellerHost over these capabilities with `changes` (for refusals).
  const startShipped = (changes) => seller.startSellerHost({ ...capabilities(), dataDirectory, artifactAnchor, ...changes });
  // The host stopped and its agent composed over the same state (the caller closes it).
  const agentFor = async ({ stopHost = true, readIssued = null } = {}) => {
    if (stopHost) { await host.close(); hosts.splice(hosts.indexOf(host), 1); }
    return seller.createSellerAgent({ ...capabilities(), durableDirectory: join(dataDirectory, 'seller'), nativeArtifactAnchor: artifactAnchor, readIssued });
  };
  // Model an authenticated checkpoint written by an older agent before its
  // adapter recovery fix, using the store's own fenced save and signature.
  const editRetainedSession = async (jobId, edit) => {
    await host.close(); hosts.splice(hosts.indexOf(host), 1);
    const { createSellerDurableState } = await import('../src/dacs/seller-durable-state.mjs');
    const state = await createSellerDurableState({ dir: join(dataDirectory, 'seller'), signer: sellerSigner, listingPin: pin });
    try { await state.withJob(jobId, (session) => { edit(session); state.saveSession(session); }); }
    finally { state.close(); }
    host = await start();
  };
  // A buyer-signed payment claim as the transport authenticates it.
  const signedClaim = async (p, txHash) => {
    const body = { jobId: p.jobId, txHash, payerPayingKey: buyerKey.claim, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE }, text = JSON.stringify(body);
    const { payload, header } = await seller.createSellerTransportClientAuth({ buyerSigner: { claim: buyerKey.claim, sign: buyerKey.sign }, seller: sellerKey.claim,
      resolveJob: () => ({ listingPin: pin, agreementHash: p.agreementHash }), now: clock }).request('/dacs/v1/payments', body, text);
    return { request: payload, header, body, rawBody: Buffer.from(text) };
  };
  const createsAt = (logicalAddress) => node.creates.filter((entry) => entry.logicalAddress === logicalAddress).length;
  const signedCreate = (logicalAddress) => clone(signedCreates.get(logicalAddress));
  const writtenAt = (logicalAddress) => clone(written.get(logicalAddress));
  // Another write of the seller's account takes the nonce a kept CREATE signed.
  const overtakeWallet = () => node.create(sellerKey, { logicalAddress: 'dacs4:TEST-other-write', artifact: { TEST: 'another write of the seller wallet' }, artifactKind: 'TEST-other' });
  return { node, effects, faults, purchase, restart, restartWallet, replaceWallet, replaceDeliveryWallet, openDeliveryJournal, overtakeWallet, deliveryWallet: () => deliveryJournalWallet, retainedSession, crashMidClaim, startShipped, evidenceConsumer, openJournal, walletJournal: () => journal,
    host: () => host, capabilities, dataDirectory, createsAt, signedCreate, writtenAt, sellerKey, buyerKey, listing, rails, otherRail: () => railSteward().railAuthority(), agentFor, signedClaim, editRetainedSession };
}

const paymentAddress = (p) => core.paymentEvidenceAddress(p.jobId, p.payout.railId, p.payout.phaseIndex);
const shown = (answer) => JSON.stringify(answer);

test('the host takes a native payment to anchored, read-back payment evidence and hands the order to delivery; the confirmed anchor is never sent again', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p);
  const answer = await p.claim(tx);
  assert.equal(answer.status, 'payment-evidenced', shown(answer));
  assert.equal(answer.evidenceAddress, address);
  assertDeliveryStage(answer,w);
  // The evidence CREATE reads back as this payment's seller-signed SettlementEvidence.
  const read = await w.node.reader.read(address, { expectedWriter: w.sellerKey.claim, expectedArtifactKind: 'SettlementEvidence', signedProjection: answer.signedProjection });
  assert.equal(read.status, 'present');
  assert.equal(core.contentHash(read.artifact), answer.evidenceHash);
  assert.equal(read.artifact.jobId, p.jobId);
  assert.deepEqual(read.artifact.paymentTxRefs.map((ref) => ref.txHash), [tx]);
  assert.deepEqual(w.effects.signCreate, [address]);
  // While the delivery is not final, each claim runs the retained work again,
  // also on a restarted host: it reads the confirmed anchor back and sends nothing.
  assert.equal((await p.claim(tx)).status, 'payment-evidenced');
  await w.restart();
  assert.equal((await p.claim(tx)).status, 'payment-evidenced');
  assert.deepEqual(w.effects.signCreate, [address], 'a confirmed anchor is not signed again');
  assert.equal(w.effects.broadcast.length, 1, 'nor sent again');
  assert.equal(w.createsAt(address), 1);
});

test('an anchor whose answer was lost after the write is read back, not sent again', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p);
  w.faults.broadcast.push('lost');
  const answer = await p.claim(tx);
  assert.equal(answer.status, 'payment-evidenced', shown(answer));
  assert.equal((await p.claim(tx)).status, 'payment-evidenced');
  assert.deepEqual(w.effects.signCreate, [address]);
  assert.equal(w.effects.broadcast.length, 1);
  assert.equal(w.createsAt(address), 1);
});

test('an indeterminate readback sends nothing: the anchor is sent again only on a proven absence', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p);
  w.faults.signCreate.push('throw');
  assert.equal((await p.claim(tx)).status, 'held');
  w.node.faults.indexDown = (programName) => programName === core.logicalToStorageProgramName(address);
  const unknown = await p.claim(tx);
  assert.equal(unknown.status, 'held', shown(unknown));
  assert.equal(unknown.readback, 'indeterminate');
  assert.deepEqual(w.effects.signCreate, [address], 'nothing is asked or sent while the readback is unknown');
  w.node.faults.indexDown = () => false;
  assert.equal((await p.claim(tx)).status, 'payment-evidenced');
  assert.deepEqual(w.effects.signCreate, [address, address]);
  assert.equal(w.effects.signed.length, 1);
  assert.equal(w.createsAt(address), 1);
});

test('a confirmed anchor is not sent again when the name index later reads it absent', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p);
  assert.equal((await p.claim(tx)).status, 'payment-evidenced');
  w.node.faults.indexEmpty = (programName) => programName === core.logicalToStorageProgramName(address);
  await p.claim(tx);
  w.node.faults.indexEmpty = () => false;
  assert.equal((await p.claim(tx)).status, 'payment-evidenced');
  assert.deepEqual(w.effects.signCreate, [address]);
  assert.equal(w.effects.broadcast.length, 1);
  assert.equal(w.createsAt(address), 1);
});

// DACS-4 PC-7(b) is write-once and a name-index miss is no proof of absence
// (CORE §5.1): the node answers its name search only for programs already
// applied in a block and, besides a nonce its writer's account has reached,
// rejects only an existing storage address, which is nonce-derived, so a
// second CREATE under the same name lands. An anchor that was sent (or whose
// answer was lost) and does not read back yet is waited for: the journal
// broadcasts the same signed bytes again and nothing is signed anew.
for (const [label, fault] of [['an anchor the wallet sent', undefined], ['an anchor whose answer was lost after the write', 'lost']]) {
  test(`${label} is not sent again while the name index lags: one CREATE (DACS-4 PC-7(b) write-once)`, async (t) => {
    const w = await world(t);
    const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p), name = core.logicalToStorageProgramName(address);
    w.node.faults.indexEmpty = (programName) => programName === name;
    if (fault) w.faults.broadcast.push(fault);
    for (const claim of [1, 2, 3]) {
      const held = await p.claim(tx);
      assert.ok(['held','payment-evidenced'].includes(held.status),shown(held));
      if(held.status==='held')assert.equal(held.readback,'indeterminate');else assertDeliveryStage(held,w);
      if(held.status==='held')assert.equal(held.anchorOutcome,fault?'unknown':'sent');
    }
    await w.restart();
    assert.ok(['held','payment-evidenced'].includes((await p.claim(tx)).status),'restart preserves the one CREATE');
    assert.deepEqual(w.effects.signCreate, [address], 'the wallet is asked to sign once');
    assert.equal(new Set(w.effects.broadcast).size, 1, 'every broadcast is the same signed bytes');
    assert.equal(w.createsAt(address), 1, 'one CREATE at the payment address');
    // The index catches up: the one CREATE reads back and the order goes on.
    w.node.faults.indexEmpty = () => false;
    const answer = await p.claim(tx);
    assert.equal(answer.status, 'payment-evidenced', shown(answer));
    assertDeliveryStage(answer,w);
    assert.deepEqual(w.effects.signCreate, [address]);
    assert.equal(w.createsAt(address), 1);
  });
}

test('the host does not start without the wallet\'s journal question: a paid order whose anchor outcome is unknown would have no way on', async (t) => {
  await assert.rejects(world(t, { reconcile: false }), { name: 'TypeError', message: /requires reconcilePaymentEvidence$/ });
});

// DACS-4 PC-7(b): the answer that lets the agent sign the same evidence again
// ('unsigned' from the reconciliation; no answer of the anchor does) is taken
// only from one package wallet journal, which keeps every signed CREATE and
// reads its fate from the chain. A wallet that would answer falsely never
// reaches the host (nor an agent composed directly: seller-settlement-profile).
test('the host takes the evidence anchor and its reconciliation only from one wallet journal: a scripted \'refused\' or \'unsigned\' answer cannot authorize a second signature', async (t) => {
  const w = await world(t);
  const journal = w.walletJournal(), other = w.openJournal('other-journal.sqlite');
  t.after(() => other.close());
  const refused = async () => ({ status: 'refused', reason: 'TEST a wallet that says it sent nothing' });
  const unsigned = async () => ({ status: 'unsigned', reason: 'TEST a wallet that says nothing can land' });
  for (const [label, nativeAnchor, reconcilePaymentEvidence] of [['a scripted anchor and reconciliation', refused, unsigned],
    ['the journal\'s anchor with a scripted reconciliation', journal.anchorEvidence, unsigned], ['a scripted anchor with the journal\'s reconciliation', refused, journal.reconcilePaymentEvidence],
    ['the anchor and the reconciliation of two journals', journal.anchorEvidence, other.reconcilePaymentEvidence], ['the reconciliation as the anchor', journal.reconcilePaymentEvidence, journal.reconcilePaymentEvidence]]) {
    await assert.rejects(w.startShipped({ nativePaymentEvidence: w.evidenceConsumer(nativeAnchor), reconcilePaymentEvidence }),
      { name: 'TypeError', message: /only from one createPaymentEvidenceWalletJournal/ }, label);
  }
  // The running host's own journal still takes the order to delivery, signed once.
  const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p);
  assert.equal((await p.claim(tx)).status, 'payment-evidenced');
  assert.equal(w.effects.signed.length, 1);
  assert.equal(w.createsAt(address), 1);
});

// DACS-4 PC-7(b): after the evidence checkpoint the agent's retained work
// decides what a retry may send. A readback that fails on the buyer's retry
// (the node's name index answers 503 once) is a held answer with its cause,
// never an uncertain effect that only a read-only reconciliation can reach.
test('a readback outage on the buyer\'s retry keeps the paid order a retry: once the node answers, the evidence is anchored once and the order is delivered, also across a restart', async (t) => {
  for (const [label, kind, fault, restart] of [['signing threw', 'signCreate', 'throw', false], ['a dropped broadcast, across a restart', 'broadcast', 'drop', true]]) {
    const w = await world(t);
    const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p);
    w.faults[kind].push(fault);
    assert.equal((await p.claim(tx)).status, 'held', label);
    let outage = 1;
    w.node.faults.indexDown = () => outage-- > 0;
    const down = await p.claim(tx);
    assert.equal(down.status, 'held', `${label}: ${shown(down)}`);
    assert.equal(down.readback, 'indeterminate', label);
    assert.match(down.reason, /^(seller-commitment-readback-unavailable: |SR-2 observation unavailable: )/, `${label}: the cause is kept`);
    assert.equal(typeof down.nativeReadCode, 'string', label);
    if (restart) await w.restart();
    let answer = down;
    for (let claim = 0; claim < 3 && answer.status !== 'payment-evidenced'; claim++) answer = await p.claim(tx);
    assert.equal(answer.status, 'payment-evidenced', `${label}, restart ${restart}: ${shown(answer)}`);
    assertDeliveryStage(answer,w);
    assert.equal(w.createsAt(address), 1, `${label}: one CREATE`);
    assert.equal(w.effects.signed.length, 1, `${label}: signed once`);
  }
});

// The same, after a crash: a host that died during a payment claim
// leaves the claim reserved and never finished in its transport journal. The
// restarted host runs the retained work again through reconciliation (read
// back first; the journal decides any resend), never sends twice, and hands
// the claim back to the ordinary retry until the order is delivered.
test('a payment claim a crash left reserved and unfinished is not stranded: the restarted host runs the retained work again, anchors once and delivers', async (t) => {
  for (const [label, kind, fault] of [['signing threw', 'signCreate', 'throw'], ['the broadcast was dropped', 'broadcast', 'drop']]) {
    const w = await world(t);
    const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p);
    w.faults[kind].push(fault);
    assert.equal((await p.claim(tx)).status, 'held', label);
    await w.crashMidClaim(p, tx);
    let answer = { status: 'not-claimed' };
    for (let claim = 0; claim < 3 && answer.status !== 'payment-evidenced'; claim++) answer = await p.claim(tx);
    assert.equal(answer.status, 'payment-evidenced', `${label}: ${shown(answer)}`);
    assertDeliveryStage(answer,w);
    assert.equal(w.createsAt(address), 1, `${label}: one CREATE`);
    assert.equal(w.effects.signed.length, 1, `${label}: signed once`);
    assert.equal(new Set(w.effects.broadcast).size, 1, `${label}: every broadcast is the same signed bytes`);
    assert.equal((await p.claim(tx)).status, 'payment-evidenced', `${label}: the delivered order answers again`);
    assert.equal(w.createsAt(address), 1);
  }
});

test('a paid outside buyer recovers an uncertain payment after access closes and restart, with one signed evidence CREATE', async (t) => {
  const paidJobs = new Set(), buyers = new Map();
  const access = { openBuyerAccess: true, custodyBuyer: key().claim, paymentObserved: jobId => paidJobs.has(jobId), buyerForJob: jobId => buyers.get(jobId) };
  const w = await world(t, { buyerAccessOptions: access });
  const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p);
  buyers.set(p.jobId,w.buyerKey.address);
  w.faults.broadcast.push('drop');
  assert.equal((await p.claim(tx)).status, 'held');
  const retained = await w.retainedSession(p.jobId);
  assert.equal(retained.nativeEvidenceWork.txHash, tx, 'the seller verified this payment before closure');
  paidJobs.add(p.jobId); // The operator's trusted job-scoped paid observation.
  access.openBuyerAccess = false;
  w.restartWallet();
  await w.crashMidClaim(p, tx);
  assert.equal(w.capabilities().buyerAccess.allowsWallet(w.buyerKey.address), false);
  const signed = await w.signedClaim(p, tx);
  const response = await fetch(`${w.host().url}/dacs/v1/payments`, { method: 'POST',
    headers: { 'content-type': 'application/json', [SELLER_TRANSPORT_HEADER]: signed.header }, body: signed.rawBody });
  const pending = await response.json();
  assert.equal(response.status, 200, shown(pending));
  assert.equal(pending.status, 'held', 'the rebroadcast is read back on the next retry');
  const answer = await p.claim(tx);
  assert.equal(answer.status, 'payment-evidenced', shown(answer));
  assert.equal(answer.delivery?.status, 'delivery-ready', shown(answer));
  const again = await p.claim(tx);
  assert.equal(again.delivery?.status, 'delivery-ready', shown(again));
  assert.equal(again.evidenceHash, answer.evidenceHash);
  assert.deepEqual(w.effects.signCreate, [address], 'one signature, including before the crash');
  assert.equal(w.createsAt(address), 1);
  assert.equal(new Set(w.effects.broadcast).size, 1, 'all broadcasts use the retained signed bytes');
});

test('closed-access recovery uses paid-job authority for reconcile and resume; unpaid outsiders only inspect issued unknown writes', async (t) => {
  for (const paid of [true, false]) {
    const paidJobs = new Set(), buyers = new Map();
    const access = { openBuyerAccess: true, custodyBuyer: key().claim, paymentObserved: jobId => paidJobs.has(jobId), buyerForJob: jobId => buyers.get(jobId) };
    const w = await world(t, { buyerAccessOptions: access });
    const p = await w.purchase(), tx = paid ? p.pay() : core.sha256Hex('TEST-unpaid-claim'), address = paymentAddress(p);
    buyers.set(p.jobId,w.buyerKey.address);
    if (paid) {
      w.faults.signCreate.push('throw');
      assert.equal((await p.claim(tx)).status, 'held');
      paidJobs.add(p.jobId);
    }
    access.openBuyerAccess = false;
    let reads = 0;
    const unknown = { status: 'TEST-issued-unknown-readback' };
    let issued = unknown;
    const recovery = await w.agentFor({ readIssued: async (jobId, options) => {
      assert.equal(jobId, p.jobId); assert.deepEqual(options, { unknownOnly: true }); reads++; return issued;
    } });
    try {
      const result = await recovery.reconcile({ jobId: p.jobId });
      if (paid) {
        assert.notDeepEqual(result, unknown);
        const resumed = await recovery.resume({ jobId: p.jobId });
        assert.equal(resumed.delivery?.status, 'delivery-ready', shown(resumed));
        assert.equal(reads, 0, 'paid recovery bypasses the unpaid read-only exception');
        assert.deepEqual(w.effects.signCreate, [address, address], 'the first call threw before signing');
        assert.equal(w.effects.signed.length, 1);
        assert.equal(w.createsAt(address), 1);
      } else {
        const before = clone(w.effects), searches = [...w.node.searches];
        assert.deepEqual(result, unknown);
        assert.deepEqual(await recovery.resume({ jobId: p.jobId }), unknown);
        assert.equal((await recovery.reconcileTransport(await w.signedClaim(p, tx))).disposition, 'indeterminate');
        assert.equal(reads, 3, 'only issued unknown writes are inspected');
        issued = null;
        await assert.rejects(recovery.reconcile({ jobId: p.jobId }), { code: 'buyer_access_closed' });
        await assert.rejects(recovery.resume({ jobId: p.jobId }), { code: 'buyer_access_closed' });
        const held = await recovery.reconcileTransport(await w.signedClaim(p, tx));
        assert.equal(held.disposition, 'indeterminate');
        assert.match(held.reason, /buyer_access_closed; no unknown issued write/);
        assert.equal(reads, 6);
        assert.deepEqual(w.node.searches, searches, 'no native read outside the issued-write exception');
        assert.deepEqual(w.effects, before, 'no new seller effects for an unpaid outside buyer');
        assert.equal(w.effects.signed.length, 0);
        assert.equal(w.createsAt(address), 0);
      }
    } finally { recovery.close(); }
  }
});

// The same before the evidence checkpoint: a host that died during the
// buyer's first payment claim, before the agent retained any work, sent
// nothing (everything before the checkpoint is free of external effects and
// replay-idempotent). The restarted host runs that claim again from its start
// through reconciliation and hands it back to the ordinary retry: the paid
// order is anchored once and delivered, and a repeated claim answers the same.
test('a crash during the first payment claim, before any work is retained, does not strand the paid order: the restarted host runs the claim again, anchors once and delivers', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p);
  await w.crashMidClaim(p, tx);
  assert.equal((await w.retainedSession(p.jobId)).nativeEvidenceWork, undefined, 'no work was retained before the crash');
  await w.restart();
  let answer = { status: 'not-claimed' };
  for (let claim = 0; claim < 3 && answer.status !== 'payment-evidenced'; claim++) answer = await p.claim(tx);
  assert.equal(answer.status, 'payment-evidenced', shown(answer));
  assertDeliveryStage(answer,w);
  assert.equal(w.createsAt(address), 1, 'one CREATE');
  assert.equal(w.effects.signed.length, 1, 'signed once');
  const again = await p.claim(tx);
  assert.equal(again.status, 'payment-evidenced', 'the repeated claim answers the same');
  assert.equal(again.evidenceHash, answer.evidenceHash);
  assert.equal(w.createsAt(address), 1);
  assert.equal(w.effects.signed.length, 1);
});

// DACS-4 PC-7(b) with the package's own wallet journal: the exact signed
// CREATE is kept before it is broadcast, so after a throw before signing, a
// dropped broadcast or a lost answer, and a restart of both the host and the
// wallet, the order is delivered with one CREATE, signed once, and every
// broadcast carries the same signed bytes.
test('the shipped wallet journal takes a paid order to delivery with one CREATE after a throw before signing, a dropped broadcast or a lost answer, across a restart of the host and the wallet', async (t) => {
  for (const [label, kind, fault] of [['signing threw', 'signCreate', 'throw'], ['the broadcast was dropped', 'broadcast', 'drop'], ['the broadcast answer was lost', 'broadcast', 'lost']]) {
    const w = await world(t);
    const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p);
    w.faults[kind].push(fault);
    const first = await p.claim(tx);
    if (fault !== 'lost') assert.equal(first.status, 'held', `${label}: ${shown(first)}`);
    w.restartWallet();
    await w.restart();
    let answer = first;
    for (let claim = 0; claim < 3 && answer.status !== 'payment-evidenced'; claim++) answer = await p.claim(tx);
    assert.equal(answer.status, 'payment-evidenced', `${label}: ${shown(answer)}`);
    assertDeliveryStage(answer,w);
    assert.equal(w.createsAt(address), 1, `${label}: one CREATE`);
    assert.equal(w.effects.signed.length, 1, `${label}: signed once`);
    assert.equal(new Set(w.effects.broadcast).size, 1, `${label}: every broadcast is the same signed bytes`);
  }
});

// DACS-4 PC-7(b) with the shipped journal when the kept CREATE can no longer
// be included: its broadcast was dropped and another job's commitment, a later
// write of the same seller wallet, landed above its nonce. The journal reads
// that from the chain, answers 'unsigned', and the same evidence is signed
// anew once: one evidence CREATE, and the order is delivered.
test('the shipped wallet journal signs anew, once, an evidence CREATE another write of the seller wallet overtook: one CREATE and delivery, also across a restart of the host and the wallet', async (t) => {
  for (const restart of [false, true]) {
    const w = await world(t);
    const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p);
    w.faults.broadcast.push('drop');
    const held = await p.claim(tx);
    assert.equal(held.status, 'held', shown(held));
    assert.equal(w.createsAt(address), 0, 'the node did not apply it');
    const overtaken = w.signedCreate(address);
    await w.purchase();
    assert.ok(w.node.accountNonce(w.sellerKey.address) > overtaken.content.nonce, 'another job\'s commitment landed above the kept nonce');
    if (restart) { w.restartWallet(); await w.restart(); }
    let answer = held;
    for (let claim = 0; claim < 3 && answer.status !== 'payment-evidenced'; claim++) answer = await p.claim(tx);
    assert.equal(answer.status, 'payment-evidenced', `restart ${restart}: ${shown(answer)}`);
    assertDeliveryStage(answer,w);
    assert.equal(w.createsAt(address), 1, 'one evidence CREATE');
    assert.equal(w.effects.signed.length, 2, 'signed anew once');
    assert.notEqual(w.signedCreate(address).hash, overtaken.hash, 'the applied CREATE is the new signature');
    assert.equal(w.node.transactionState(overtaken.hash), 'absent', 'the overtaken CREATE never lands');
    assert.equal((await p.claim(tx)).status, 'payment-evidenced');
    assert.equal(w.effects.signed.length, 2, 'once read back, never signed again');
    assert.equal(w.createsAt(address), 1);
  }
});

// DACS-4 PC-7(b): the anchor retry catches up, idempotent on the payment
// address. An attempt that was sent or whose outcome is unknown and does not
// read back is resolved by the wallet's own journal (reconcilePaymentEvidence):
// only 'unsigned' lets the same evidence be anchored again; a rebroadcast of
// the one signed transaction is waited for. A throw from the wallet is not a
// refusal: the anchor's own answer never lets it be sent again.
test('a wallet that threw before signing is asked its journal: nothing signed, so the same evidence is sent once more and the order is delivered, also after a restart', async (t) => {
  for (const restart of [false, true]) {
    const w = await world(t);
    const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p);
    w.faults.signCreate.push('throw');
    const held = await p.claim(tx);
    assert.equal(held.status, 'held', shown(held));
    assert.equal(held.anchorOutcome, 'failed-before-signing', 'the owning journal proves no CREATE was retained after the throw');
    assert.equal(held.anchorError?.code, 'TEST-wallet-failed', 'the wallet error keeps its cause');
    assert.equal(held.readback, 'indeterminate', 'the first claim only reads back');
    assert.deepEqual(w.effects.signCreate, [address]);
    if (restart) await w.restart();
    const answer = await p.claim(tx);
    assert.equal(answer.status, 'payment-evidenced', shown(answer));
    assertDeliveryStage(answer,w);
    assert.deepEqual(w.effects.signCreate, [address, address], 'asked again once, after the journal proved nothing signed');
    assert.equal(w.effects.signed.length, 1, 'signed once');
    assert.equal(w.createsAt(address), 1, 'one CREATE');
    assert.equal((await p.claim(tx)).status, 'payment-evidenced');
    assert.equal(w.effects.signCreate.length, 2, 'once read back, never sent again');
  }
});

test('a sent anchor the node dropped is broadcast again as the same signed transaction, never signed anew: one CREATE, then delivery', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p);
  w.faults.broadcast.push('drop');
  const held = await p.claim(tx);
  assert.equal(held.status, 'held', shown(held));
  assert.equal(held.anchorOutcome, 'sent');
  assert.equal(w.createsAt(address), 0, 'the node did not apply it');
  const signed = w.signedCreate(address);
  await w.restart();
  const pending = await p.claim(tx);
  assert.equal(pending.status, 'held', 'the rebroadcast is waited for, not read in the same claim');
  assert.equal(w.effects.broadcast.length, 2, 'the journal broadcast it again');
  assert.equal(w.createsAt(address), 1, 'the same signed CREATE landed');
  assert.deepEqual(w.signedCreate(address), signed, 'the exact signed bytes, not a new transaction');
  const answer = await p.claim(tx);
  assert.equal(answer.status, 'payment-evidenced', shown(answer));
  assert.deepEqual(w.effects.signCreate, [address], 'the wallet is asked to sign once');
  assert.equal(new Set(w.effects.broadcast).size, 1, 'every broadcast is the same signed bytes');
  assert.equal(w.createsAt(address), 1);
});


test('a journal that cannot read a kept CREATE\'s fate signs nothing anew: the claim stays held, and once the read answers the evidence is signed anew once and delivered', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p);
  w.faults.broadcast.push('drop');
  assert.equal((await p.claim(tx)).status, 'held');
  const overtaken = w.signedCreate(address);
  await w.purchase();
  assert.ok(w.node.accountNonce(w.sellerKey.address) > overtaken.content.nonce, 'another job\'s commitment landed above the kept nonce');
  w.faults.readAccountNonce.push('throw', 'throw');
  for (const claim of [1, 2]) {
    const held = await p.claim(tx);
    assert.ok(['held','payment-evidenced'].includes(held.status),shown(held));
    assert.equal(held.anchorOutcome, 'sent', `claim ${claim}`);
  }
  assert.equal(w.effects.signed.length, 1, 'nothing is signed anew while the fate is unread');
  assert.equal(new Set(w.effects.broadcast).size, 1, 'only the kept bytes are broadcast');
  assert.equal(w.createsAt(address), 0);
  let answer = { status: 'not-claimed' };
  for (let claim = 0; claim < 3 && answer.status !== 'payment-evidenced'; claim++) answer = await p.claim(tx);
  assert.equal(answer.status, 'payment-evidenced', shown(answer));
  assert.equal(w.effects.signed.length, 2, 'signed anew once');
  assert.equal(w.createsAt(address), 1);
  const work = (await w.retainedSession(p.jobId)).nativeEvidenceWork;
  assert.equal(work.reconcileAnswer.status, 'unsigned');
  assert.match(work.reconcileAnswer.reason, /not executed through block [0-9]+.*can no longer be executed$/, 'only the bounded status, hash and reason of a journal answer are kept');
  assert.equal(work.anchorOutcome, 'sent', 'the one new signature was sent');
});

// Settlement credit (SB-2): one transfer claimed by two jobs gives neither
// job credit. Job A's failed anchor leaves its checkpoint bound to the
// transfer; once job B claims it too, job A reads nothing back, sends nothing
// and gets no answer about the job.
test('settlement credit: a transfer another job also claims is anchored for neither job and handed to no delivery', async (t) => {
  const w = await world(t);
  const a = await w.purchase(), b = await w.purchase(), tx = a.pay(), address = paymentAddress(a);
  w.faults.signCreate.push('throw');
  assert.equal((await a.claim(tx)).status, 'held');
  assert.deepEqual(await b.claim(tx), { status: 'indeterminate', reason: 'settlement-collision' });
  const reads = w.node.searches.length;
  assert.equal((await a.claim(tx)).error, 'seller_unavailable', 'no answer for a job whose credit is contested');
  assert.deepEqual(w.node.searches.slice(reads).filter((name) => name === core.logicalToStorageProgramName(address)), [], 'the contested checkpoint is not read back');
  assert.deepEqual(w.effects.signCreate, [address], 'nothing is anchored once the credit is contested');
  assert.equal(w.createsAt(address) + w.createsAt(paymentAddress(b)), 0);
});

test('settlement credit is checked again right before the anchor is sent: a claim on another job during the readback stops it', async (t) => {
  const w = await world(t);
  const a = await w.purchase(), b = await w.purchase(), tx = a.pay(), address = paymentAddress(a), name = core.logicalToStorageProgramName(address);
  w.faults.signCreate.push('throw');
  assert.equal((await a.claim(tx)).status, 'held');
  let contested = null;
  w.node.faults.beforeSearch = async (programName) => { if (programName === name && contested === null) contested = await b.claim(tx); };
  assert.equal((await a.claim(tx)).error, 'seller_unavailable');
  assert.deepEqual(contested, { status: 'indeterminate', reason: 'settlement-collision' }, 'job B claimed the transfer while job A read back');
  assert.deepEqual(w.effects.signCreate, [address], 'job A sends nothing once its credit is contested');
  assert.equal(w.createsAt(address), 0);
});

// Another tool holding the seller's key landed its own CREATE at the payment
// address, of seller-signed evidence naming another transfer, in place of the
// journal's: it reads back, but not as this payment's evidence.
test('a readback that is not this payment\'s evidence is refused before delivery', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p);
  w.faults.broadcast.push('other');
  const answer = await p.claim(tx);
  assert.equal(answer.status, 'rejected', shown(answer));
  assert.equal(answer.reason, 'native-payment-evidence-scope-mismatch');
  assert.equal(answer.delivery, undefined, 'no delivery is attempted');
  assert.equal((await p.claim(tx)).status, 'rejected');
  assert.deepEqual(w.effects.signCreate, [address], 'a CREATE that is present is never sent again');
  assert.equal(w.effects.broadcast.length, 1);
});

// Delivery. Each party's Vet record is verified by its counterparty (DACS-2
// §7.7.2), as the core delivery runner checks in the audit source.
test('a native payment is delivered: the Deliverable CREATE reads back bound to the Agreement and the settlement', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay(), deliverable = `dacs4:deliverable:${p.jobId}`;
  // Payment evidence, the settlement credit on the payment permit, then the Deliverable.
  const answer = await p.claim(tx);
  assert.equal(answer.status, 'payment-evidenced', shown(answer));
  assert.equal(answer.delivery?.status, 'delivery-ready', shown(answer.delivery));
  assert.equal(answer.delivery.logicalAddress, deliverable);
  assert.deepEqual(w.effects.signCreate, [paymentAddress(p)]);
  assert.deepEqual(w.effects.deliverySubmit, [deliverable]);
  assert.equal(w.createsAt(deliverable), 1);
  // The CREATE reads back as the seller's Deliverable for this job, Agreement and settlement.
  const binding = answer.delivery.deliveryBinding;
  assert.deepEqual([binding.jobId, binding.agreementHash], [p.jobId, core.contentHash(p.agreement)]);
  const read = await w.node.reader.read(deliverable, { expectedWriter: w.sellerKey.claim, expectedArtifactKind: 'Deliverable', signedProjection: w.signedCreate(deliverable),
    expectedDeliveryBinding: binding });
  assert.equal(read.status, 'present');
  assert.equal(core.contentHash(read.artifact), answer.delivery.contentHash);
  assert.deepEqual([read.artifact.jobId, read.artifact.agreementHash, read.artifact.settlementId], [p.jobId, core.contentHash(p.agreement), answer.settlementId]);
  // A later claim, also on a restarted host, reads the delivery back and sends nothing.
  assert.equal((await p.claim(tx)).delivery?.status, 'delivery-ready');
  await w.restart();
  const again = await p.claim(tx);
  assert.equal(again.delivery?.status, 'delivery-ready', shown(again.delivery));
  assert.equal(again.delivery.contentHash, answer.delivery.contentHash);
  assert.deepEqual(w.effects.deliverySubmit, [deliverable], 'the Deliverable is sent once');
  assert.equal(w.createsAt(deliverable), 1);
});

test('a Deliverable the producer does not bind to this job, Agreement and settlement is not sent', async (t) => {
  const changes = { 'another job': { jobId: '01J8N4YV7YVYQ4DB7M8T'+String(++jobSequence).padStart(6,'0') }, 'another Agreement': { agreementHash: core.sha256Hex('TEST another Agreement') },
    'another settlement': { settlementId: core.sha256Hex('TEST another settlement') } };
  for (const [label, change] of Object.entries(changes)) {
    const w = await world(t, { deliverableProducer: report(change) });
    const p = await w.purchase(), tx = p.pay(), deliverable = `dacs4:deliverable:${p.jobId}`;
    const answer = await p.claim(tx);
    assert.equal(answer.status, 'payment-evidenced', `${label}: ${shown(answer)}`);
    assert.equal(answer.delivery?.status, 'held', `${label}: ${shown(answer.delivery)}`);
    assert.match(answer.delivery.reason, /the application deliverable is not bound to this Agreement and settlement/, label);
    assert.deepEqual(w.effects.deliverySubmit, [], `${label}: nothing is sent`);
    assert.equal(w.createsAt(deliverable), 0, label);
  }
});

// The SDK submits the candidate it prepared; the seller sends it only if it is
// still the exact report the producer answers for this job and settlement.
// With a schema the SDK's schema verifier compares it too; without one, the
// seller's check at submission is the only one.
test('a delivery candidate that is not the exact report is not sent: the producer answered differently at submission', async (t) => {
  for (const schemaUrl of [true, false]) {
    let answers = 0;
    const w = await world(t, { schemaUrl, deliverableProducer: (input) => report({ body: [`TEST report, answer ${String(++answers).padStart(8, '0')}`] })(input) });
    assert.equal('schemaUrl' in w.listing.offering.deliverable, schemaUrl);
    const p = await w.purchase(), tx = p.pay(), deliverable = `dacs4:deliverable:${p.jobId}`, label = schemaUrl ? 'with a schema' : 'without a schema';
    const answer = await p.claim(tx);
    assert.equal(answer.status, 'payment-evidenced', `${label}: ${shown(answer)}`);
    assert.equal(answer.delivery?.status, 'held', `${label}: ${shown(answer.delivery)}`);
    assert.deepEqual(w.effects.deliverySubmit, [], `${label}: nothing is sent`);
    assert.equal(w.createsAt(deliverable), 0, label);
  }
});

test('without a schema in the Listing, a native payment is delivered', async (t) => {
  const w = await world(t, { schemaUrl: false });
  const p = await w.purchase(), tx = p.pay(), deliverable = `dacs4:deliverable:${p.jobId}`;
  const answer = await p.claim(tx);
  assert.equal(answer.delivery?.status, 'delivery-ready', shown(answer.delivery));
  assert.deepEqual(w.effects.deliverySubmit, [deliverable]);
  assert.equal(w.createsAt(deliverable), 1);
});

// Settlement credit (SB-2) on the payment permit: job B claims job A's
// transfer after A's delivery has read its audit source and before A's permit
// is consumed. Neither job has credit: A's permit is refused, not spent, and
// A's Deliverable is not sent. The SDK receipt store elects one of the two
// claims on its own (both are observed at the transfer's inclusion, so the
// lower evidence hash wins) and takes the permit from a job it does not elect.
// A is the job it elects: only the seller's credit check refuses A's permit.
test('settlement credit is checked again before the Deliverable is sent: a claim on another job during the delivery stops it', async (t) => {
  const w = await world(t);
  // Both jobs pay the same payee the same amount, so one transfer serves either.
  const x = await w.purchase(), y = await w.purchase(), tx = x.pay(), { blockNumber, includedAt } = w.node.inclusion(tx);
  const evidenceInput = (p) => ({ evidenceVersion: '1', jobId: p.jobId, phase: 'pay-dem', outcome: 'success', paymentTxRefs: [{ kind: 'demos', txHash: tx, blockNumber }],
    paymentAmount: clone(p.agreement.terms.price), settlementFinality: { model: 'bft-final', finalityObservedAt: includedAt }, observedAt: includedAt });
  const [a, b] = core.contentHash(evidenceInput(x)) < core.contentHash(evidenceInput(y)) ? [x, y] : [y, x], deliverable = `dacs4:deliverable:${a.jobId}`;
  let contested = null;
  w.faults.beforeDeliveryReconcile = async () => { if (contested === null) contested = await b.claim(tx); };
  assert.equal((await a.claim(tx)).error, 'seller_unavailable', 'no answer for a job whose credit is contested');
  assert.deepEqual(contested, { status: 'indeterminate', reason: 'settlement-collision' }, 'job B claimed the transfer during job A\'s delivery');
  assert.deepEqual(w.effects.signCreate, [paymentAddress(a)], 'job A\'s payment evidence was anchored before the claim on job B');
  assert.deepEqual(w.effects.deliverySubmit, [], 'job A\'s Deliverable is not sent');
  assert.equal(w.createsAt(deliverable), 0);
  // A's anchored evidence is the input A's election was computed from.
  const { signature: _signature, ...anchored } = w.writtenAt(paymentAddress(a));
  assert.deepEqual(anchored, evidenceInput(a));
  const retained = await w.retainedSession(a.jobId);
  assert.equal(retained.settlementCredit, 'indeterminate');
  assert.deepEqual([retained.deliveryHold?.result?.decision, retained.deliveryHold?.result?.code], ['rejected', 'payment-permit-invalid'], shown(retained.deliveryHold));
});

// A crash during a first claim that is not a valid payment (a transfer the
// node does not have, or an underpaid one): the restarted host runs it again
// from its start; it keeps nothing, so its effect is released as on the
// ordinary path and the buyer's corrected claim is delivered.
test('a crash during a first claim that keeps nothing does not bind the job to it: the corrected claim after the restart is delivered', async (t) => {
  const w = await world(t);
  for (const [label, wrong] of [['a transfer the node does not have', () => 'ab'.repeat(32)], ['an underpaid transfer', (p) => w.node.pay({ from: w.buyerKey.address, to: p.payout.payeeAddress, amountOs: '1' })]]) {
    const p = await w.purchase(), first = wrong(p);
    await w.crashMidClaim(p, first);
    const reconciled = await p.claim(first);
    assert.ok(['indeterminate', 'rejected'].includes(reconciled.status), `${label}: ${shown(reconciled)}`);
    const tx = p.pay(), answer = await p.claim(tx);
    assert.equal(answer.status, 'payment-evidenced', `${label}: ${shown(answer)}`);
    assert.equal(answer.delivery?.status, 'delivery-ready', `${label}: ${shown(answer.delivery)}`);
    assert.deepEqual((await p.claim(first)).error, 'peer_operation_conflict', `${label}: the paid claim now holds the job`);
    assert.equal(w.createsAt(paymentAddress(p)), 1, label);
  }
});

// The README composes the evidence consumer with only the journal's anchor;
// the agent reads the signed CREATE's public projection from that journal.
test('a consumer composed as the README shows, without a projection reader, takes a paid order to delivery: the agent reads the projection from the wallet journal', async (t) => {
  const w = await world(t, { projectionReader: false });
  const p = await w.purchase(), tx = p.pay();
  const answer = await p.claim(tx);
  assert.equal(answer.status, 'payment-evidenced', shown(answer));
  assert.equal(answer.delivery?.status, 'delivery-ready', shown(answer.delivery));
  assert.deepEqual(answer.signedProjection, w.signedCreate(paymentAddress(p)), 'the journal\'s exact signed CREATE');
  await w.restart();
  assert.equal((await p.claim(tx)).delivery?.status, 'delivery-ready');
  assert.deepEqual(w.effects.signCreate, [paymentAddress(p)]);
  assert.deepEqual(await w.walletJournal().readSignedProjection({ logicalAddress: paymentAddress(p) }), w.signedCreate(paymentAddress(p)));
  assert.equal(await w.walletJournal().readSignedProjection({ logicalAddress: `${paymentAddress(p)}:TEST-other` }), null);
});

// A Deliverable that landed while the seller's records after it were lost: a
// later run reads it back first and never submits it again on a name-index miss.
test('a landed Deliverable whose records were lost is not submitted again while its readback lags: one CREATE, then delivery', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay(), deliverable = `dacs4:deliverable:${p.jobId}`, name = core.logicalToStorageProgramName(deliverable);
  w.faults.deliverySubmit.push('land-lose-lock');
  w.node.faults.indexEmpty = (programName) => programName === name;
  assert.equal((await p.claim(tx)).error, 'seller_unavailable', 'the job lost its lock during the submission');
  await w.restart();
  for (const claim of [1, 2]) {
    const held = await p.claim(tx);
    assert.notEqual(held.delivery?.status, 'delivery-ready', `claim ${claim}: ${shown(held)}`);
  }
  assert.deepEqual(w.effects.deliverySubmit, [deliverable], 'the Deliverable is submitted once');
  w.node.faults.indexEmpty = () => false;
  const answer = await p.claim(tx);
  assert.equal(answer.delivery?.status, 'delivery-ready', shown(answer));
  assert.deepEqual(w.effects.deliverySubmit, [deliverable]);
  assert.equal(w.createsAt(deliverable), 1);
});

// The Deliverable's submission is recorded before the capability is asked, so a
// failure or a death before anything is signed leaves a record with no CREATE.
// A reader that kept no signed CREATE proves that absence, and the paid order is
// then submitted again, once (README: the delivery capability's contract).
test('a Deliverable submission that fails before anything is signed does not strand the paid order: the next claim submits it once, with and without a restart', async (t) => {
  for (const restart of [false, true]) {
    const w = await world(t);
    const p = await w.purchase(), tx = p.pay(), deliverable = `dacs4:deliverable:${p.jobId}`;
    w.faults.deliverySubmit.push('fail');
    assert.equal((await p.claim(tx)).error, 'seller_unavailable', `restart ${restart}: the first submission failed`);
    assert.deepEqual(w.effects.deliverySubmit, [deliverable]);
    assert.equal(w.createsAt(deliverable), 0, 'nothing was signed');
    if (restart) await w.restart();
    const answer = await p.claim(tx);
    assert.equal(answer.delivery?.status, 'delivery-ready', `restart ${restart}: ${shown(answer)}`);
    assert.deepEqual(w.effects.deliverySubmit, [deliverable, deliverable], 'asked again after the proven absence');
    assert.equal(w.createsAt(deliverable), 1, 'exactly one CREATE');
    assert.equal((await p.claim(tx)).delivery?.status, 'delivery-ready');
    assert.equal(w.createsAt(deliverable), 1);
  }
});

// Without a Deliverable wallet journal the proof is the capability's: a CREATE
// it signed and kept, whose answer was lost before it was broadcast, reads back
// as a plain absence. The host holds it and never asks again, since the kept
// bytes may still land (with the journal the host sends them again: below).
test('a Deliverable a capability without a wallet journal signed but lost is held, never submitted again, whatever the read says', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay(), deliverable = `dacs4:deliverable:${p.jobId}`;
  w.faults.deliverySubmit.push('sign-then-lose');
  assert.equal((await p.claim(tx)).error, 'seller_unavailable');
  for (const restart of [false, true]) {
    if (restart) await w.restart();
    for (const claim of [1, 2]) {
      const held = await p.claim(tx);
      assert.notEqual(held.delivery?.status, 'delivery-ready', `restart ${restart}, claim ${claim}: ${shown(held)}`);
    }
  }
  assert.deepEqual(w.effects.deliverySubmit, [deliverable], 'the Deliverable is asked for once');
});

// CORE §5.1 (and the retry rule of DACS-4 PC-7(b) applied to the Deliverable):
// with the Deliverable wallet journal the signed CREATE is kept
// before it is broadcast, so a plain absence of a submitted Deliverable is
// answered by sending the same bytes again, never by a second signature. When
// the call that signed it fails ('throw'), the next claim sends it again; when
// the node accepted the submission and then dropped it ('drop'), the
// reconciliation of the same call does. It holds until the CREATE reads back, and
// the claim after that delivers.
for (const [label, fault, claimsToResend] of [['whose broadcast failed after signing', 'throw', 2], ['whose broadcast the node dropped', 'drop', 1]]) {
  for (const restart of [false, true]) {
    test(`a Deliverable CREATE ${label} is sent again as the same bytes and delivered, signed once${restart ? ', across a restart of the host and the wallet' : ''}`, async (t) => {
      const w = await world(t, { deliveryJournal: true });
      const p = await w.purchase(), tx = p.pay(), deliverable = `dacs4:deliverable:${p.jobId}`;
      w.faults.deliveryBroadcast.push(fault);
      let sent = await p.claim(tx);
      assert.notEqual(sent.delivery?.status, 'delivery-ready', 'the Deliverable was signed, not on the chain');
      if (restart) { w.restartWallet(); await w.restart(); }
      if (claimsToResend === 2) sent = await p.claim(tx);
      assert.equal(sent.delivery?.status, 'held', shown(sent));
      assert.match(sent.delivery.reason, /rebroadcast/, 'the kept CREATE was sent again');
      const answer = await p.claim(tx);
      assert.equal(answer.delivery?.status, 'delivery-ready', shown(answer));
      assert.deepEqual(w.effects.deliverySignCreate, [deliverable], 'the wallet signed the Deliverable once');
      assert.equal(new Set(w.effects.deliveryBroadcast).size, 1, 'every broadcast is the same signed bytes');
      assert.equal(w.createsAt(deliverable), 1);
      assert.equal((await p.claim(tx)).delivery?.status, 'delivery-ready');
      assert.equal(w.createsAt(deliverable), 1, 'a delivered order sends nothing more');
    });
  }
}

// The journal keeps the signed CREATE, so a failed rebroadcast is not a
// delivery: the order is held, and the held cause is the journal's own
// (a refused broadcast is told apart from a timeout or a lost answer).
test('a kept Deliverable CREATE whose rebroadcast fails is held with the journal\'s cause, signed once', async (t) => {
  const w = await world(t, { deliveryJournal: true });
  const p = await w.purchase(), tx = p.pay(), deliverable = `dacs4:deliverable:${p.jobId}`;
  w.faults.deliveryBroadcast.push('throw', 'throw');
  assert.notEqual((await p.claim(tx)).delivery?.status, 'delivery-ready', 'the first broadcast failed');
  const held = await p.claim(tx);
  assert.equal(held.delivery?.status, 'held', shown(held));
  assert.match(held.delivery.reason, /TEST delivery broadcast failed/, 'the journal\'s cause is kept, not replaced by a bare status');
  assert.equal(w.effects.deliveryBroadcast.length, 2, 'the kept bytes were sent again once');
  assert.deepEqual(w.effects.deliverySignCreate, [deliverable], 'the wallet signed the Deliverable once');
  const resent = await p.claim(tx);
  assert.equal(resent.delivery?.status, 'held', shown(resent));
  assert.match(resent.delivery.reason, /rebroadcast/, 'the next claim sends the kept bytes again');
  const answer = await p.claim(tx);
  assert.equal(answer.delivery?.status, 'delivery-ready', shown(answer));
  assert.equal(w.createsAt(deliverable), 1);
});

test('a Deliverable CREATE the node applied whose answer was lost is read back, not broadcast again', async (t) => {
  const w = await world(t, { deliveryJournal: true });
  const p = await w.purchase(), tx = p.pay(), deliverable = `dacs4:deliverable:${p.jobId}`;
  w.faults.deliveryBroadcast.push('lost');
  assert.equal((await p.claim(tx)).error, 'seller_unavailable');
  const answer = await p.claim(tx);
  assert.equal(answer.delivery?.status, 'delivery-ready', shown(answer));
  assert.equal(w.effects.deliveryBroadcast.length, 1, 'broadcast once');
  assert.deepEqual(w.effects.deliverySignCreate, [deliverable]);
  assert.equal(w.createsAt(deliverable), 1);
});

test('a Deliverable read that fails does not ask the wallet journal: nothing is sent while the readback is unknown', async (t) => {
  const w = await world(t, { deliveryJournal: true });
  const p = await w.purchase(), tx = p.pay();
  w.faults.deliveryBroadcast.push('throw');
  assert.equal((await p.claim(tx)).error, 'seller_unavailable');
  w.faults.deliveryRead.push('throw');
  const held = await p.claim(tx);
  assert.equal(held.delivery?.status, 'held', shown(held));
  assert.match(held.delivery.reason, /TEST delivery node unreachable/, 'the read failure is the cause');
  assert.equal(w.effects.deliveryBroadcast.length, 1, 'the kept CREATE is not sent again on an unreadable answer');
});

// A thrown complete miss (the node's name index or native-address search found
// nothing) is not a read failure: with the journal it is a plain absence, so the
// journal sends the kept signed bytes again. The same bytes, signed once.
for (const observation of ['name-index-miss', 'native-address-miss']) {
  test(`a Deliverable read that throws ${observation} asks the journal: the kept bytes are sent again once, signed once`, async (t) => {
    const w = await world(t, { deliveryJournal: true });
    const p = await w.purchase(), tx = p.pay(), deliverable = `dacs4:deliverable:${p.jobId}`;
    w.faults.deliveryBroadcast.push('throw');
    assert.equal((await p.claim(tx)).error, 'seller_unavailable');
    w.faults.deliveryRead.push(observation);
    const held = await p.claim(tx);
    assert.equal(held.delivery?.status, 'held', shown(held));
    assert.match(held.delivery.reason, /rebroadcast/, 'the journal asked for the kept bytes to be sent again');
    assert.equal(w.effects.deliveryBroadcast.length, 2, 'exactly one resend');
    assert.equal(new Set(w.effects.deliveryBroadcast).size, 1, 'the same signed bytes');
    assert.deepEqual(w.effects.deliverySignCreate, [deliverable], 'the wallet signed the Deliverable once');
    const answer = await p.claim(tx);
    assert.equal(answer.delivery?.status, 'delivery-ready', shown(answer));
    assert.equal(w.createsAt(deliverable), 1);
  });
}

// The same complete miss thrown by the capability's reconcile is also only a
// plain absence: the journal, not the adapter, decides whether to send again.
for (const observation of ['name-index-miss', 'native-address-miss']) {
  test(`a Deliverable reconcile that throws ${observation} asks the journal: the kept bytes are sent again once, signed once`, async (t) => {
    const w = await world(t, { deliveryJournal: true });
    const p = await w.purchase(), tx = p.pay(), deliverable = `dacs4:deliverable:${p.jobId}`;
    w.faults.deliveryBroadcast.push('drop');
    w.faults.deliveryReconcile.push(observation);
    const held = await p.claim(tx);
    assert.equal(held.delivery?.status, 'held', shown(held));
    assert.match(held.delivery.reason, /rebroadcast/, 'the journal asked for the kept bytes to be sent again');
    assert.equal(w.effects.deliveryBroadcast.length, 2, 'exactly one resend');
    assert.equal(new Set(w.effects.deliveryBroadcast).size, 1, 'the same signed bytes');
    assert.deepEqual(w.effects.deliverySignCreate, [deliverable], 'the wallet signed the Deliverable once');
    const answer = await p.claim(tx);
    assert.equal(answer.delivery?.status, 'delivery-ready', shown(answer));
    assert.equal(w.createsAt(deliverable), 1);
  });
}

// The journal, not the reader, authorizes a new signature: a submission that
// failed before the wallet signed anything is answered `unsigned`.
test('a Deliverable submission that failed before signing is signed once by the next claim on the journal\'s answer', async (t) => {
  const w = await world(t, { deliveryJournal: true });
  const p = await w.purchase(), tx = p.pay(), deliverable = `dacs4:deliverable:${p.jobId}`;
  w.faults.deliverySignCreate.push('throw');
  assert.equal((await p.claim(tx)).error, 'seller_unavailable');
  assert.equal(w.createsAt(deliverable), 0, 'nothing was signed');
  const answer = await p.claim(tx);
  assert.equal(answer.delivery?.status, 'delivery-ready', shown(answer));
  assert.equal(w.effects.deliverySigned.length, 1);
  assert.equal(w.createsAt(deliverable), 1);
});

test('a kept Deliverable CREATE another write of the wallet overtook is signed anew once, and the overtaken one never lands', async (t) => {
  const w = await world(t, { deliveryJournal: true });
  const p = await w.purchase(), tx = p.pay(), deliverable = `dacs4:deliverable:${p.jobId}`;
  w.faults.deliveryBroadcast.push('throw');
  assert.equal((await p.claim(tx)).error, 'seller_unavailable');
  const [overtaken] = w.effects.deliverySigned;
  w.overtakeWallet();
  const answer = await p.claim(tx);
  assert.equal(answer.delivery?.status, 'delivery-ready', shown(answer));
  assert.equal(w.effects.deliverySigned.length, 2, 'one new signature');
  assert.equal(w.node.transactionState(overtaken), 'absent', 'the overtaken CREATE did not execute');
  assert.equal(w.createsAt(deliverable), 1);
});

// The SDK keeps an accepted submission as its outcome, so it never submits it
// again: a CREATE that was accepted, dropped and then overtaken stays held.
test('an accepted Deliverable CREATE the node dropped and another write of the wallet overtook stays held: no second signature', async (t) => {
  const w = await world(t, { deliveryJournal: true });
  const p = await w.purchase(), tx = p.pay(), deliverable = `dacs4:deliverable:${p.jobId}`;
  w.faults.deliveryBroadcast.push('drop', 'drop');
  assert.match((await p.claim(tx)).delivery?.reason, /rebroadcast/, 'sent again, and dropped again');
  w.overtakeWallet();
  for (const claim of [1, 2]) {
    const held = await p.claim(tx);
    assert.equal(held.delivery?.status, 'held', `claim ${claim}: ${shown(held)}`);
    assert.match(held.delivery.reason, /can no longer be executed/, `claim ${claim}: the journal\'s supersession cause is kept`);
  }
  assert.equal(w.effects.deliverySigned.length, 1, 'never signed a second time');
  assert.equal(w.createsAt(deliverable), 0, 'nothing landed');
});

// A journal file that is not the one that kept the submission (lost, replaced,
// or none recorded) keeps nothing of it: it is not asked, and nothing is signed.
test('a replaced Deliverable wallet journal is not asked: the order is held and signs nothing until the file is restored', async (t) => {
  const w = await world(t, { deliveryJournal: true });
  const p = await w.purchase(), tx = p.pay(), deliverable = `dacs4:deliverable:${p.jobId}`;
  w.faults.deliveryBroadcast.push('throw');
  assert.equal((await p.claim(tx)).error, 'seller_unavailable');
  w.replaceDeliveryWallet('replaced-delivery-journal.sqlite'); await w.restart();
  for (const claim of [1, 2]) {
    const held = await p.claim(tx);
    assert.equal(held.delivery?.status, 'held', `claim ${claim}: ${shown(held)}`);
    assert.match(held.delivery.reason, /wallet_journal_changed/);
  }
  assert.deepEqual(w.effects.deliverySignCreate, [deliverable], 'nothing is signed by the other journal');
  w.replaceDeliveryWallet('delivery-wallet-journal.sqlite'); await w.restart();
  await p.claim(tx);
  assert.equal((await p.claim(tx)).delivery?.status, 'delivery-ready');
  assert.equal(w.effects.deliverySigned.length, 1);
  assert.equal(w.createsAt(deliverable), 1);
});

test('a Deliverable submission recorded with no wallet journal is not asked of the configured one', async (t) => {
  const w = await world(t, { deliveryJournal: true });
  const p = await w.purchase(), tx = p.pay();
  w.faults.deliveryBroadcast.push('throw');
  assert.equal((await p.claim(tx)).error, 'seller_unavailable');
  await w.editRetainedSession(p.jobId, (session) => { delete session.deliveryWalletJournal; });
  const held = await p.claim(tx);
  assert.equal(held.delivery?.status, 'held', shown(held));
  assert.match(held.delivery.reason, /wallet_journal_changed/);
  assert.equal(w.effects.deliveryBroadcast.length, 1, 'the kept CREATE is not sent again');
});

test('a Deliverable wallet journal that fails when asked keeps the order held with its cause, and the order is delivered once it answers', async (t) => {
  const w = await world(t, { deliveryJournal: true });
  const p = await w.purchase(), tx = p.pay(), deliverable = `dacs4:deliverable:${p.jobId}`;
  w.faults.deliveryBroadcast.push('throw');
  assert.equal((await p.claim(tx)).error, 'seller_unavailable');
  w.deliveryWallet().close();
  const held = await p.claim(tx);
  assert.equal(held.delivery?.status, 'held', shown(held));
  assert.match(held.delivery.reason, /not open/, 'the journal\'s own error is the cause');
  w.replaceDeliveryWallet('delivery-wallet-journal.sqlite'); await w.restart();
  await p.claim(tx);
  assert.equal((await p.claim(tx)).delivery?.status, 'delivery-ready');
  assert.deepEqual(w.effects.deliverySignCreate, [deliverable]);
});

test('the host takes the Deliverable question only from the journal whose submit the capability is: a scripted answer, another journal or the evidence journal is refused', async (t) => {
  const w = await world(t, { deliveryJournal: true }), plain = await world(t);
  const other = w.openDeliveryJournal('other-delivery-journal.sqlite');
  t.after(() => other.close());
  for (const [label, changes] of [['a scripted question', { reconcileDeliverableCreate: async () => ({ status: 'unsigned' }) }],
    ['another journal\'s question', { reconcileDeliverableCreate: other.reconcile }],
    ['the evidence journal\'s question', { reconcileDeliverableCreate: w.walletJournal().reconcilePaymentEvidence }],
    ['the journal\'s question over a capability that is not its submit', { nativeDemDelivery: plain.capabilities().nativeDemDelivery }]]) {
    await assert.rejects(w.startShipped(changes), { name: 'TypeError', message: /reconcileDeliverableCreate/ }, label);
  }
});

// The package's Vet provider presents the seller's Listing identity afresh for
// each session (to the buyer's challenge): the seller accepts that exact
// presentation, signed by itself, and refuses one it did not sign.
test('the seller takes its own session presentation from the Vet context to delivery, and refuses one it did not sign', async (t) => {
  const w = await world(t, { sellerPresentation: 'session' });
  const p = await w.purchase(), tx = p.pay();
  const seller = p.agreement.parties.find((party) => party.role === 'seller');
  assert.notEqual(seller.bundleHash, core.identityBundleHash(w.listing.seller.identity), 'the Agreement carries the session presentation');
  const answer = await p.claim(tx);
  assert.equal(answer.delivery?.status, 'delivery-ready', shown(answer));
  const forged = await world(t, { sellerPresentation: 'forged' });
  await assert.rejects(forged.purchase(), /the seller signs the vetted Agreement: .*seller identity differs: the seller bundle presentation does not verify/);
});

// A signer that fails while signing the payment evidence released no
// signature: the next claim signs the same evidence and the order is delivered.
test('a seller signer failure while signing the payment evidence does not strand the paid order, also across a restart', async (t) => {
  const w = await world(t);
  for (const restart of [false, true]) {
    const p = await w.purchase(), tx = p.pay();
    w.faults.sign.push('throw-evidence');
    const refused = await p.claim(tx);
    assert.deepEqual([refused.status, refused.reason, refused.step], ['indeterminate', 'seller_native_evidence_not_started', 'evidence-signing'], shown(refused));
    if (restart) await w.restart();
    const answer = await p.claim(tx);
    assert.equal(answer.delivery?.status, 'delivery-ready', `restart ${restart}: ${shown(answer)}`);
    assert.equal(w.createsAt(paymentAddress(p)), 1);
  }
});

// The transport admits a 0x-prefixed transaction hash; the agent reads it as
// core payment intake does.
test('a payment claimed with a 0x-prefixed transaction hash is delivered, its evidence naming the plain hash', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay();
  const answer = await p.claim(`0x${tx}`);
  assert.equal(answer.delivery?.status, 'delivery-ready', shown(answer));
  assert.equal(w.writtenAt(paymentAddress(p)).paymentTxRefs[0].txHash, tx);
  assert.equal((await p.claim(`0x${tx}`)).delivery?.status, 'delivery-ready');
});

// A held paid claim whose next run a gate refuses (a rotated steward key
// refuses its pinned rail) keeps its effect and slot: a different claim in the
// meantime is refused, never bound to the job, and the paid claim is delivered.
test('a gate that refuses a held paid claim for now keeps it bound to the job: another claim cannot take it, and the claim is delivered once the gate passes', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay(), name = core.logicalToStorageProgramName(paymentAddress(p)), original = w.rails.authority;
  w.node.faults.indexEmpty = (programName) => programName === name;
  assert.equal((await p.claim(tx)).status, 'held');
  w.rails.authority = w.otherRail(); await w.restart();
  assert.equal((await p.claim(tx)).error, 'seller_unavailable', 'the pinned rail is refused for now');
  w.rails.authority = original; await w.restart();
  const second = p.pay();
  for (const other of [`0x${tx}`, second]) assert.equal((await p.claim(other)).error, 'peer_operation_conflict', `another claim (${other.slice(0, 6)}) is refused`);
  w.node.faults.indexEmpty = () => false;
  const answer = await p.claim(tx);
  assert.equal(answer.delivery?.status, 'delivery-ready', shown(answer));
  await w.restart();
  assert.equal((await p.claim(tx)).delivery?.status, 'delivery-ready');
});

// DACS-4 PC-7(b): a lost or replaced wallet-journal file keeps nothing of the
// anchor already sent; the agent never asks it about that attempt, so nothing
// is signed twice, and the order goes on once the one CREATE reads back.
test('a replaced wallet-journal file never signs a second evidence CREATE for an anchor the earlier one sent', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p), name = core.logicalToStorageProgramName(address);
  w.node.faults.indexEmpty = (programName) => programName === name;
  assert.equal((await p.claim(tx)).anchorOutcome, 'sent');
  w.replaceWallet('replaced-wallet-journal.sqlite'); await w.restart();
  for (const claim of [1, 2]) {
    const held = await p.claim(tx);
    assert.ok(['held','payment-evidenced'].includes(held.status),shown(held));
    assert.equal(held.reconcileError?.code, 'wallet_journal_changed', shown(held));
  }
  assert.deepEqual(w.effects.signCreate, [address], 'signed once');
  assert.equal(w.createsAt(address), 1);
  w.node.faults.indexEmpty = () => false;
  assert.equal((await p.claim(tx)).delivery?.status, 'delivery-ready');
  assert.equal(w.createsAt(address), 1);
});

// The agent's own reconciliation of an uncertain payment claim for a request
// whose session delegation expired (readOnly) runs nothing that can sign or send.
test('read-only reconciliation of a held payment claim neither signs nor sends: it is not run again', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p), name = core.logicalToStorageProgramName(address);
  w.node.faults.indexEmpty = (programName) => programName === name;
  assert.equal((await p.claim(tx)).status, 'held');
  const agent = await w.agentFor();
  try {
    const before = { signCreate: [...w.effects.signCreate], broadcast: w.effects.broadcast.length };
    const proof = await agent.reconcileTransport({ ...(await w.signedClaim(p, tx)), readOnly: true });
    assert.equal(proof.disposition, 'indeterminate', shown(proof));
    assert.match(proof.reason, /peer_delegation_expired/);
    assert.deepEqual({ signCreate: w.effects.signCreate, broadcast: w.effects.broadcast.length }, before, 'nothing signed or broadcast');
    assert.equal((await agent.reconcileTransport(await w.signedClaim(p, tx))).disposition, 'retry', 'control: a live request runs the retained work');
  } finally { agent.close(); }
});

// README (Scope): this package is a fixture-only kit. Nothing in it can read or
// write a real Demos node, so the capabilities it builds refuse a real node's
// endpoint, an unregistered source and a non-TEST authority; the claim is pinned
// here so it cannot drift into one of a seller that runs on a real node.
test('the package builds capabilities only for the loopback fixture node and TEST authorities: a real node endpoint and an unregistered source are refused', () => {
  for (const rpcUrl of ['https://node2.demos.sh/', 'http://node2.demos.sh/', 'http://localhost:53550/', 'http://127.0.0.1:9/node']) {
    assert.throws(() => createNativePaymentEvidenceConsumer({ rpcUrl }), { name: 'TypeError', message: /owned literal loopback or the exact opaque source/ }, rpcUrl);
  }
  assert.throws(() => createNativePaymentEvidenceConsumer({ rpcUrl: 'https://node2.demos.sh/', sourceCapability: {} }), { name: 'TypeError', message: /exact opaque SettlementEvidence source capability/ });
  const operations = { submit: async () => null, reconcile: async () => null, read: async () => null, verifyReceipt: async () => null };
  assert.throws(() => createNativeDemDeliveryCapability({ authority: 'node2.demos.sh', ...operations }), { name: 'TypeError', message: /explicit TEST authority/ });
  assert.doesNotThrow(() => createNativeDemDeliveryCapability({ authority: 'TEST-scope', ...operations }));
});

test('a paid native order with an additive signature field in its DeliverableSpec reaches delivery, including restart', async (t) => {
  const w = await world(t, { deliverableExtension: { signature: { format: 'TEST-spec-extension' } } });
  const p = await w.purchase(), tx = p.pay();
  const answer = await p.claim(tx);
  assert.equal(answer.status, 'payment-evidenced', shown(answer));
  assert.equal(answer.delivery?.status, 'delivery-ready', shown(answer));
  await w.restart();
  assert.equal((await p.claim(tx)).delivery?.status, 'delivery-ready');
  assert.equal(w.createsAt(`dacs4:deliverable:${p.jobId}`), 1);
});

test('a supersession decision lost before the agent checkpoint replays after restart and delivers once', async (t) => {
  const w = await world(t), p = await w.purchase(), tx = p.pay(), address = paymentAddress(p);
  w.faults.broadcast.push('drop');
  assert.equal((await p.claim(tx)).status, 'held');
  const old = w.signedCreate(address);
  await w.purchase(); // Its commitment overtakes the dropped evidence nonce.
  const kept = await w.retainedSession(p.jobId); // Stop the host before the cut.
  const answer = await w.walletJournal().reconcilePaymentEvidence({ logicalAddress: address, receiptContentHash: kept.nativeEvidenceWork.intake.evidenceHash,
    attempt: { answer: { txHash: old.hash } } });
  assert.equal(answer.status, 'unsigned');
  assert.equal(answer.txHash, old.hash);
  // Process death here: the wallet decision is durable, the agent saw none of it.
  w.restartWallet(); await w.restart();
  const delivered = await p.claim(tx);
  assert.equal(delivered.delivery?.status, 'delivery-ready', shown(delivered));
  assert.equal(w.createsAt(address), 1);
  assert.equal(w.effects.signed.length, 2);
});

test('a commitment readback outage on the first payment claim stays indeterminate and recovers', async (t) => {
  const w = await world(t), p = await w.purchase(), tx = p.pay();
  let outage = 1;
  w.node.faults.indexDown = () => outage-- > 0;
  const held = await p.claim(tx);
  assert.equal(held.status, 'indeterminate', shown(held));
  assert.equal(w.effects.signCreate.length, 0);
  await w.restart();
  const answer = await p.claim(tx);
  assert.equal(answer.delivery?.status, 'delivery-ready', shown(answer));
  assert.equal(w.createsAt(paymentAddress(p)), 1);
});


test('a paid order resumes once after restart with a rotated steward and trusted historical key; new orders pin the new steward', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p);
  w.faults.signCreate.push('throw');
  assert.notEqual((await p.claim(tx)).status, 'payment-evidenced');
  const previous = w.rails.authority;
  w.rails.authority = { ...w.otherRail(), historicalStewards: [{ stewardClaim: previous.stewardClaim, stewardPublicKey: previous.stewardPublicKey }] };
  await w.restart();
  const answer = await p.claim(tx);
  assert.equal(answer.status, 'payment-evidenced', shown(answer));
  assert.equal(answer.delivery?.status, 'delivery-ready', shown(answer));
  await w.restart();
  assert.equal((await p.claim(tx)).delivery?.status, 'delivery-ready');
  assert.equal(w.createsAt(address), 1);
  assert.equal(w.createsAt(`dacs4:deliverable:${p.jobId}`), 1);
  const next = await w.purchase();
  const session = await w.retainedSession(next.jobId);
  assert.equal(session.railPin.rail.signature.signer, w.rails.authority.stewardClaim);
  assert.notEqual(session.railPin.rail.signature.signer, previous.stewardClaim);
});

test('complete payload digest includes a top-level signature and survives restart', async (t) => {
  const w = await world(t, { deliverableProducer: report({ signature: { application: 'opaque report data' } }) });
  const p = await w.purchase(), tx = p.pay();
  const first = await p.claim(tx);
  assert.equal(first.delivery?.status, 'delivery-ready', shown(first));
  const payload = w.writtenAt(`dacs4:deliverable:${p.jobId}`), digest = core.sha256Hex(core.canonicalize(payload));
  assert.notEqual(digest, core.contentHash(payload));
  assert.equal(first.delivery.contentHash, digest);
  assert.equal(first.delivery.deliveryBinding.payloadHash, digest);
  await w.restart();
  assert.equal((await p.claim(tx)).delivery?.contentHash, digest);
  assert.equal(w.effects.deliverySubmit.length, 1);
});

test('a Promise producer gives a clear deterministic synchronous contract error', async (t) => {
  const w = await world(t, { deliverableProducer: async input => report()(input) });
  const p = await w.purchase(), answer = await p.claim(p.pay());
  assert.equal(answer.delivery?.status, 'held', shown(answer));
  assert.match(answer.delivery.reason, /must synchronously return deterministic JSON/);
  assert.deepEqual(w.effects.deliverySubmit, []);
});

test('declared delivery schema is enforced before publication; conforming payload is delivered', async (t) => {
  const schemaUrl = 'urn:TEST:report-with-mustHave';
  const deliverySchemaVerifier = { schemaUrl, verify: ({ cleartextPayload }) => ({ disposition: typeof cleartextPayload.mustHave === 'string' ? 'valid' : 'invalid' }) };
  for (const valid of [false, true]) {
    const w = await world(t, { deliverableExtension: { schemaUrl }, deliverySchemaVerifier, deliverableProducer: report(valid ? { mustHave: 'present' } : {}) });
    const p = await w.purchase(), answer = await p.claim(p.pay());
    assert.equal(answer.delivery?.status, valid ? 'delivery-ready' : 'held', shown(answer));
    assert.equal(w.effects.deliverySubmit.length, valid ? 1 : 0);
  }
  const w = await world(t);
  const agent = await w.agentFor(); agent.close();
  await assert.rejects(w.startShipped({ deliverySchemaVerifier: null }), /unsupported delivery schema/);
  await assert.rejects(w.startShipped({ deliverySchemaVerifier: { ...deliverySchemaVerifier, schemaUrl: 'urn:wrong' } }), /unsupported delivery schema/);
});

test('foreign same-name binary programs do not obstruct authentic seller evidence or delivery', async (t) => {
  const w = await world(t), p = await w.purchase(), tx = p.pay();
  const address = 'stor-' + 'fa'.repeat(20);
  w.node.programs.set(address, { success: true, storageAddress: address, owner: w.buyerKey.address, programName: core.logicalToStorageProgramName(paymentAddress(p)), data: 'binary program', metadata: null });
  const answer = await p.claim(tx);
  assert.equal(answer.delivery?.status, 'delivery-ready', shown(answer));
  assert.equal(w.effects.deliverySubmit.length, 1);
});

test('an unavailable schema verifier preserves the permit and recovers on retry, including after restart', async (t) => {
  for (const restart of [false, true]) {
    let available = false;
    const schemaUrl = 'urn:TEST:temporarily-unavailable-schema';
    const w = await world(t, { deliverableExtension: { schemaUrl }, deliverySchemaVerifier: {
      schemaUrl, verify: () => available ? { disposition: 'valid' } : { disposition: 'indeterminate', reason: 'TEST schema authority unavailable' },
    } });
    const p = await w.purchase(), tx = p.pay();
    const held = await p.claim(tx);
    assert.equal(held.delivery?.status, 'held', shown(held));
    assert.match(held.delivery.reason, /TEST schema authority unavailable/);
    assert.equal(w.effects.deliverySubmit.length, 0);
    if (restart) await w.restart();
    available = true;
    const done = await p.claim(tx);
    assert.equal(done.delivery?.status, 'delivery-ready', shown(done));
    assert.equal(w.effects.deliverySubmit.length, 1);
    assert.equal(w.createsAt(paymentAddress(p)), 1, 'recovery uses the original payment');
  }
});

test('an unspecified-size Listing with oversized actual output is refused before any Agreement', async (t) => {
  const producer = (input) => {
    const payload = report({ body: [''] })(input);
    payload.body[0] = 'a'.repeat(131073 - Buffer.byteLength(core.canonicalize(payload)));
    return payload;
  };
  const w = await world(t, { deliverableProducer: producer, omitExpectedSize: true });
  const answer = await w.purchase({ expectSigned: false });
  assert.notEqual(answer.disposition, 'complete', shown(answer));
  assert.match(answer.reason, /unsupported Listing: inline storage delivery requires expectedSizeBytes/);
  assert.equal(w.effects.componentSigns.filter(bytes => [core.ARTIFACT_SEPARATORS.AgreementDocument, core.ARTIFACT_SEPARATORS.PayeeBoundAgreementDocument].some(separator => bytes.startsWith(separator))).length, 0, 'no Agreement contribution is signed');
  assert.equal(w.effects.published.length, 0, 'no commitment is published');
  assert.equal(w.effects.signCreate.length, 0, 'no payment evidence is signed');
  await w.restart(); // The Listing can still reopen its retained state for recovery.
});

test('inline delivery refuses oversized Listings before signing and delivers the exact storage CREATE boundary', async (t) => {
  await assert.rejects(world(t, { deliverableExtension: { expectedSizeBytes: 132283 } }), /unsupported Listing: inline storage delivery/);
  await assert.rejects(world(t, { deliverableExtension: { expectedSizeBytes: 131073 } }), /unsupported Listing: inline storage delivery/);
  const size = 16384;
  const producer = (input) => {
    const payload = report({ body: [''] })(input);
    payload.body[0] = 'a'.repeat(size - Buffer.byteLength(core.canonicalize(payload)));
    return payload;
  };
  const w = await world(t, { deliverableExtension: { expectedSizeBytes: size }, deliverableProducer: producer });
  const p = await w.purchase(), answer = await p.claim(p.pay());
  assert.equal(answer.delivery?.status, 'delivery-ready', shown(answer));
  assert.equal(Buffer.byteLength(core.canonicalize(w.writtenAt(`dacs4:deliverable:${p.jobId}`))), size);
});

test('inline size admission accepts feasible minimal reports and refuses impossible declared sizes', async (t) => {
  const producer = ({ agreement, settlementId }) => ({ jobId: agreement.jobId, agreementHash: core.contentHash(agreement), settlementId });
  const w = await world(t, { schemaUrl: false, deliverableProducer: producer });
  const p = await w.purchase(), done = await p.claim(p.pay());
  assert.equal(done.delivery?.status, 'delivery-ready', shown(done));
  const size = Buffer.byteLength(core.canonicalize(w.writtenAt(`dacs4:deliverable:${p.jobId}`)));
  for (const expectedSizeBytes of [0, size - 1, size + 1, size + 4]) {
    const small = await world(t, { schemaUrl: false, deliverableProducer: producer, deliverableExtension: { expectedSizeBytes } });
    const refused = await small.purchase({ expectSigned: false });
    assert.notEqual(refused.disposition, 'complete', shown(refused));
    assert.match(refused.reason, /inline storage delivery requires expectedSizeBytes/);
  }
  const extended = await world(t, { schemaUrl: false, deliverableProducer: input => ({ ...producer(input), '': 0 }) });
  const extra = await extended.purchase(), delivered = await extra.claim(extra.pay());
  assert.equal(delivered.delivery?.status, 'delivery-ready', shown(delivered));
  assert.equal(Buffer.byteLength(core.canonicalize(extended.writtenAt(`dacs4:deliverable:${extra.jobId}`))), size + 5);
});

test('producer size mismatches hold the paid permit and recover with corrected bytes, including restart', async (t) => {
  for (const [declared, actual] of [[16000, 4000], [4000, 131073]]) for (const restart of [false, true]) {
    let size = actual;
    const producer = (input) => {
      const payload = report({ body: [''] })(input);
      payload.body[0] = 'a'.repeat(size - Buffer.byteLength(core.canonicalize(payload)));
      return payload;
    };
    const w = await world(t, { deliverableExtension: { expectedSizeBytes: declared }, deliverableProducer: producer });
    const p = await w.purchase(), tx = p.pay(), held = await p.claim(tx);
    assert.equal(held.delivery?.status, 'held', shown(held));
    assert.equal(w.effects.deliverySubmit.length, 0);
    if (restart) await w.restart();
    size = declared;
    const done = await p.claim(tx);
    assert.equal(done.delivery?.status, 'delivery-ready', shown(done));
    assert.match(held.delivery.reason, /inline delivery size/);
    assert.equal(Buffer.byteLength(core.canonicalize(w.writtenAt(`dacs4:deliverable:${p.jobId}`))), declared);
    assert.equal(w.effects.deliverySubmit.length, 1);
    assert.equal(w.createsAt(paymentAddress(p)), 1);
  }
});

test('host maxJobs above the default transport cap admits job 10001 with the ordinary nonce budget', async (t) => {
  const w = await world(t, { maxJobs: 20000 });
  const db = new DatabaseSync(join(w.dataDirectory, 'transport', 'transport.sqlite'));
  try {
    db.exec('BEGIN');
    const job = db.prepare('INSERT INTO peer_jobs VALUES (?, ?)');
    const effect = db.prepare('INSERT INTO peer_effects VALUES (?, ?, ?, ?, ?)');
    const mapping = db.prepare('INSERT INTO peer_effect_jobs VALUES (?, ?)');
    for (let i = 0; i < 10000; i++) {
      const id = '01J8N4YV7YVYQ4DB7M8T'+String(++jobSequence).padStart(6,'0');
      job.run(id, '{}');
      effect.run(id, 'TEST-completed', 'complete', 200, '{}');
      mapping.run(id, id);
    }
    db.exec('COMMIT');
  } finally { db.close(); }
  const p = await w.purchase();
  assert.equal((await p.claim(p.pay())).delivery?.status, 'delivery-ready');
});



test('a delivery evidence publisher outage remains retryable through crash reconciliation until publication completes', async (t) => {
  const w = await world(t, { deliveryEvidenceEnabled: true });
  const p = await w.purchase(), tx = p.pay();
  w.faults.artifactPublish.push('SettlementEvidence');
  const first = await p.claim(tx);
  assert.equal(first.delivery?.evidencePublication, 'held-readback-only', shown(first));
  await w.crashMidClaim(p, tx);
  w.faults.artifactPublish.push('SettlementEvidence');
  const held = await p.claim(tx);
  assert.equal(held.delivery?.evidencePublication, 'held-readback-only', shown(held));
  await w.restart();
  const done = await p.claim(tx);
  assert.equal(done.delivery?.status, 'delivered', shown(done));
  assert.equal(done.delivery?.evidencePublication, 'native-read-back', shown(done));
  assert.equal(w.effects.published.filter(kind => kind === 'SettlementEvidence').length, 1);
  assert.equal(w.createsAt(paymentAddress(p)), 1);
  assert.equal(w.effects.deliverySubmit.length, 1);
});

test('ordinary commitments recover after Agreement-read and pre-publication failures, across restart, and never repeat a CREATE', async (t) => {
  for (const failure of ['agreement', 'publisher']) {
    const w = await world(t), p = await w.purchase({ commit: false });
    if (failure === 'agreement') w.faults.agreementRead.push('throw');
    else w.faults.artifactPublish.push('FinalityCommitmentRecord');
    await assert.rejects(p.client().commit(p.jobId));
    assert.equal(w.effects.published.length, 0);
    await w.restart();
    assert.equal((await p.client().commit(p.jobId)).status, 'committed', failure);
    assert.equal((await p.client().commit(p.jobId)).status, 'committed', failure);
    assert.equal(w.effects.published.filter(kind => kind === 'FinalityCommitmentRecord').length, 1);
  }
});

test('the native host delivers without the unused compatibility observer', async (t) => {
  const w = await world(t, { compatibilityObserver: false });
  const p = await w.purchase();
  assert.equal((await p.claim(p.pay())).delivery?.status, 'delivery-ready');
});


test('an uncertain commitment CREATE only reads back after restart and is never published twice', async t => {
 const w = await world(t), p = await w.purchase({ commit: false });
 w.faults.artifactPublish.push('FinalityCommitmentRecord:land-throw');
 await assert.rejects(p.client().commit(p.jobId));
 assert.equal(w.effects.published.length, 1);
 await w.restart();
 w.faults.artifactRead.push('unknown');
 await assert.rejects(p.client().commit(p.jobId));
 assert.equal(w.effects.published.length, 1, 'uncertainty authorizes no new publication');
 assert.equal((await p.client().commit(p.jobId)).status, 'committed');
 assert.equal(w.effects.published.length, 1);
});

test('a non-idempotent commitment publisher is called once despite a lagging index and restart', async (t) => {
  const w = await world(t, { idempotentArtifacts: false }), p = await w.purchase({ commit: false });
  const address = core.finalityCommitmentAddress(p.jobId);
  w.faults.artifactPublish.push('FinalityCommitmentRecord:land-throw');
  await assert.rejects(p.client().commit(p.jobId));
  w.faults.artifactRead.push('absent');
  await assert.rejects(p.client().commit(p.jobId));
  await w.restart();
  w.faults.artifactRead.push('unbranded');
  await assert.rejects(p.client().commit(p.jobId));
  const agent = await w.agentFor();
  try {
    w.faults.artifactRead.push('absent');
    await assert.rejects(agent.resume({ jobId: p.jobId }), { code: 'commitment_failed' });
    assert.equal((await agent.resume({ jobId: p.jobId })).status, 'committed');
  } finally { agent.close(); }
  assert.equal(w.effects.published.filter(kind => kind === 'FinalityCommitmentRecord').length, 1);
  assert.equal(w.createsAt(address), 1);
});

test('read-only commitment reconciliation cannot start provably unsent work', async t => {
 const w = await world(t), p = await w.purchase({ commit: false });
 w.faults.artifactPublish.push('FinalityCommitmentRecord');
 await assert.rejects(p.client().commit(p.jobId));
 const agent = await w.agentFor();
 try {
  const body = { jobId: p.jobId }, text = JSON.stringify(body);
  const { payload } = await seller.createSellerTransportClientAuth({ buyerSigner: { claim: w.buyerKey.claim, sign: w.buyerKey.sign }, seller: w.sellerKey.claim,
   resolveJob: () => ({ listingPin: seller.listingPin(w.listing), agreementHash: p.agreementHash }), now: w.capabilities().now }).request('/dacs/v1/commitments', body, text);
  const answer = await agent.reconcileTransport({ request: payload, body, rawBody: Buffer.from(text), readOnly: true });
  assert.equal(answer.disposition, 'indeterminate');
  assert.equal(w.effects.published.length, 0);
 } finally { agent.close(); }
 await w.restart();
 assert.equal((await p.client().commit(p.jobId)).status, 'committed');
 assert.equal(w.effects.published.length, 1);
});

// The public host forwards issuance to the same verifier-owned generator.
test('the host refuses caller-chosen challenges and accepts a buyer presentation of its own challenge', async (t) => {
  const w = await world(t), jobId = '01J8N4YV7YVYQ4DB7M8T'+String(++jobSequence).padStart(6,'0');
  const chosen = identityFor(w.buyerKey, NOW);
  assert.throws(() => w.host().issueSessionChallenge({ jobId, buyer: w.buyerKey.claim, sessionNonce: chosen.sessionNonce }), { code: 'challenge_invalid' });
  assert.throws(() => w.host().issueSessionChallenge({ jobId, buyer: w.buyerKey.claim, sessionNonce: '01'.repeat(16) }), { code: 'challenge_invalid' });
  const issued = w.host().issueSessionChallenge({ jobId, buyer: w.buyerKey.claim });
  assert.match(issued.sessionNonce, /^[0-9a-f]{64}$/);
  assert.notEqual(issued.sessionNonce, chosen.sessionNonce);
  const purchase = await w.purchase({ commit: false });
  assert.match(purchase.agreementHash, /^[0-9a-f]{64}$/, 'the seller accepted the presentation and signed its Agreement');
});


// Agreement reads during execution must never replace the object the job holder
// is updating. A cached transport success still needs current durable credit.
test('concurrent Agreement state reads cannot hide settlement collisions from cached delivery answers', async (t) => {
  for (const concurrentRead of [false, true]) {
    const w = await world(t);
    const a = await w.purchase(), b = await w.purchase(), tx = a.pay();
    let observed = false;
    w.node.faults.beforeSearch = async () => {
      if (!observed) {
        observed = true;
        if (concurrentRead) {
          const state = await a.client().agreementState(a.transportIdentity);
          assert.equal(state.proposal.proposalHash, a.transportIdentity.proposalHash);
        }
      }
    };
    assert.equal((await a.claim(tx)).delivery?.status, 'delivery-ready');
    assert.equal(observed, true);
    w.node.faults.beforeSearch = async () => {};
    assert.equal((await a.claim(tx)).delivery?.status, 'delivery-ready', 'uncontested cached success is allowed');
    assert.deepEqual(await b.claim(tx), { status: 'indeterminate', reason: 'settlement-collision' });
    assert.equal((await a.claim(tx)).error, 'seller_unavailable', `concurrent read ${concurrentRead}: suspended credit cannot disclose cached success`);
    await assert.rejects(a.client().agreementState(a.transportIdentity), { code: 'seller_unavailable' });
    await w.restart();
    assert.equal((await a.claim(tx)).error, 'seller_unavailable');
    assert.equal(w.createsAt(`dacs4:deliverable:${a.jobId}`), 1);
  }
});

test('a landed Deliverable with a lost adapter checkpoint recovers on immediately successful readback with one CREATE', async (t) => {
  for (const checkpoint of ['current-intent', 'legacy-intent', 'legacy-resolution-pending']) {
    const w = await world(t);
    const p = await w.purchase(), tx = p.pay(), address = `dacs4:deliverable:${p.jobId}`;
    w.faults.deliverySubmit.push('land-lose-lock');
    assert.equal((await p.claim(tx)).error, 'seller_unavailable');
    if (checkpoint === 'current-intent') await w.restart();
    else await w.editRetainedSession(p.jobId, (session) => {
      delete session.deliveryAdapter;
      if (checkpoint === 'legacy-resolution-pending') {
        const { disposition, fulfilment, reason, permitId, ...authorization } = session.nativeEvidenceWork.intake;
        session.deliveryHold = { reason: 'indeterminate:delivery-resolution-pending:canonical delivery is absent', result: {
          decision: 'indeterminate', code: 'delivery-resolution-pending', fulfilmentId: session.deliverySubmitted[0], safeToRetryDelivery: false,
          recovery: { action: 'reconcile-delivery', reconciliationId: w.signedCreate(address).hash }, consumedPaymentAuthorization: authorization,
        } };
      }
    });
    const answer = await p.claim(tx);
    assert.equal(answer.delivery?.status, 'delivery-ready', `${checkpoint}: ${shown(answer.delivery)}`);
    for (let i = 0; i < 2; i++) assert.equal((await p.claim(tx)).delivery?.status, 'delivery-ready');
    await w.restart();
    assert.equal((await p.claim(tx)).delivery?.status, 'delivery-ready');
    assert.deepEqual(w.effects.deliverySubmit, [address]);
    assert.equal(w.createsAt(address), 1);
  }
});


test('settlement disclosure checks durable payment identities even when this agent only cached the unpaid proposal', async (t) => {
  const w = await world(t);
  const a = await w.purchase(), b = await w.purchase(), tx = a.pay();
  const stale = await w.agentFor({ stopHost: false });
  t.after(() => stale.close());
  assert.equal((await a.claim(tx)).delivery?.status, 'delivery-ready');
  assert.doesNotThrow(() => stale.assertSettlementCredit(a.jobId), 'one uncontested settlement remains allowed');
  assert.equal(typeof stale.deliveryStateOf(a.jobId).fulfilmentId, 'string');
  assert.equal(stale.stageOf(a.jobId), 'delivery-ready');
  assert.deepEqual(await b.claim(tx), { status: 'indeterminate', reason: 'settlement-collision' });
  assert.throws(() => stale.assertSettlementCredit(a.jobId), { code: 'settlement_collision' });
  assert.throws(() => stale.agreementState(a.transportIdentity), { code: 'settlement_collision' });
  assert.throws(() => stale.deliveryStateOf(a.jobId), { code: 'settlement_collision' });
  assert.equal(stale.stageOf(a.jobId), 'settlement-indeterminate');
  assert.equal(stale.durableSessionOf(a.jobId).settlementCredit, 'indeterminate');
});
for(const value of [undefined,null,0,{}])test(`missing or malformed journal identity ${JSON.stringify(value)} cannot release another journal's pending CREATE`,async t=>{
 const w=await world(t,{projectionReader:false}),p=await w.purchase(),tx=p.pay(),address=paymentAddress(p),name=core.logicalToStorageProgramName(address);w.node.faults.transactionDown=hash=>hash===w.signedCreate(address)?.hash;w.node.faults.indexEmpty=program=>program===name;w.faults.broadcast.push('lost');assert.equal((await p.claim(tx)).status,'held');await w.editRetainedSession(p.jobId,session=>{if(value===undefined)delete session.nativeEvidenceWork.walletJournal;else session.nativeEvidenceWork.walletJournal=value;});await w.host().close();w.replaceWallet('TEST-replacement.sqlite');await w.restart();w.node.faults.transactionDown=()=>false;for(let i=0;i<2;i++)assert.notEqual((await p.claim(tx)).status,'payment-evidenced');assert.equal(w.createsAt(address),1);assert.equal(w.effects.signCreate.filter(x=>x===address).length,1);
});
for(const damage of ['proof','order','deliveryReady'])test(`authenticated checkpoint ${damage} cannot return unauthenticated evidence or deliver again`,async t=>{
 const w=await world(t),p=await w.purchase(),tx=p.pay();assert.equal((await p.claim(tx)).status,'payment-evidenced');const delivered=w.effects.deliverySubmit.length;await w.editRetainedSession(p.jobId,session=>{
  const work=session.nativeEvidenceWork;if(damage==='proof')work.nativeReceipt.evidence.value='TEST-broken-proof';else if(damage==='order'){const projection=JSON.parse(work.publicSignedProjectionJson);projection.content=Object.fromEntries(Object.entries(projection.content).reverse());work.publicSignedProjectionJson=JSON.stringify(projection);}else session.deliveryReady={status:'delivery-ready'};
 });const answer=await p.claim(tx);
 if(['proof','order'].includes(damage))assert.notEqual(answer.status,'payment-evidenced');else{assert.equal(answer.status,'payment-evidenced',shown(answer));assert.equal(answer.delivery.status,'held');}
 assert.equal(w.effects.deliverySubmit.length,delivered,'the Deliverable is sent once');assert.equal(w.createsAt(paymentAddress(p)),1);
});

// A retained delivery is only a record of it: every repeat authenticates the saved
// payment evidence again, whether it reaches the agent directly, as a new claim,
// or as a replay of a request the transport already answered.
test('a retained delivery is held while its payment evidence cannot be read back, for a direct retry, a new claim and a replayed request', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay(), deliverable = `dacs4:deliverable:${p.jobId}`;
  const signed = await w.signedClaim(p, tx);
  const post = async () => (await fetch(`${w.host().url}/dacs/v1/payments`, { method: 'POST',
    headers: { 'content-type': 'application/json', [SELLER_TRANSPORT_HEADER]: signed.header }, body: signed.rawBody })).json();
  const first = await post();
  assert.equal(first.delivery?.status, 'delivery-ready', shown(first));
  const evidenceCreate = w.signedCreate(paymentAddress(p)).hash;
  w.node.faults.transactionDown = (hash) => hash === evidenceCreate;
  assert.equal((await post()).status, 'held', 'a replay of the answered request');
  assert.equal((await p.claim(tx)).status, 'held', 'a new claim');
  const agent = await w.agentFor();
  try {
    const retry = await agent.submitPayment({ jobId: p.jobId, txHash: tx, payerPayingKey: w.buyerKey.claim, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE });
    assert.equal(retry.status, 'held', 'a direct retry');
  } finally { agent.close(); }
  w.node.faults.transactionDown = () => false;
  const restarted = await w.agentFor({ stopHost: false });
  try {
    const again = await restarted.submitPayment({ jobId: p.jobId, txHash: tx, payerPayingKey: w.buyerKey.claim, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE });
    assert.equal(again.delivery?.status, 'delivery-ready', shown(again));
  } finally { restarted.close(); }
  assert.deepEqual(w.effects.deliverySubmit, [deliverable], 'the Deliverable is sent once');
  assert.equal(w.createsAt(deliverable), 1);
});

// The Deliverable is what the seller first sent. A producer that answers
// differently later (here after a restart, or after the answer to the first
// CREATE was lost with the job's records) never changes what is read back.
test('a delivery is read back from the bytes that were sent, not from what the producer answers after a restart', async (t) => {
  let body = 'TEST report body old';
  const w = await world(t, { deliverableProducer: (input) => report({ body: [body] })(input) });
  const p = await w.purchase(), tx = p.pay();
  const first = await p.claim(tx);
  assert.equal(first.delivery?.status, 'delivery-ready', shown(first));
  body = 'TEST report body new';
  const agent = await w.agentFor();
  try {
    const again = await agent.submitPayment({ jobId: p.jobId, txHash: tx, payerPayingKey: w.buyerKey.claim, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE });
    assert.equal(again.delivery?.status, 'delivery-ready', shown(again));
    assert.equal(again.delivery.contentHash, first.delivery.contentHash, 'the original bytes are verified');
  } finally { agent.close(); }
  assert.equal(w.effects.deliverySubmit.length, 1);
});

test('a Deliverable that landed while the job\'s records were lost is recovered from the bytes that were sent, whatever the producer answers after the restart', async (t) => {
  let body = 'TEST report body old';
  const w = await world(t, { deliverableProducer: (input) => report({ body: [body] })(input) });
  const p = await w.purchase(), tx = p.pay(), deliverable = `dacs4:deliverable:${p.jobId}`;
  w.faults.deliverySubmit.push('land-lose-lock');
  assert.equal((await p.claim(tx)).error, 'seller_unavailable', 'the job lost its lock during the submission');
  body = 'TEST report body new';
  await w.restart();
  const answer = await p.claim(tx);
  assert.equal(answer.delivery?.status, 'delivery-ready', shown(answer));
  assert.deepEqual(w.effects.deliverySubmit, [deliverable], 'the Deliverable is submitted once');
  assert.equal(w.createsAt(deliverable), 1);
  assert.equal(core.sha256Hex(core.canonicalize(w.writtenAt(deliverable))), answer.delivery.contentHash, 'the original bytes are verified');
});


// Delivery evidence publication (deliveryEvidenceEnabled): the SettlementEvidence
// of a delivered order is one native CREATE, read back before the answer says
// `delivered`, and only ever read back once it was asked.
const evidenceAddress = (p) => `dacs4:evidence:${p.jobId}`;
const publishedEvidence = (w) => w.effects.published.filter((kind) => kind === 'SettlementEvidence').length;
const resumed = async (w, p, options) => {
  const agent = await w.agentFor(options);
  try { return await agent.resume({ jobId: p.jobId }); } finally { agent.close(); }
};

test('without delivery evidence enabled a delivered order is delivery-ready and its evidence is left to the SDK finaliser', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), answer = await p.claim(p.pay());
  assert.equal(answer.delivery?.status, 'delivery-ready', shown(answer));
  assert.equal(answer.delivery.evidencePublication, 'deferred-to-explicit-sdk-finaliser');
  assert.equal(publishedEvidence(w), 0);
  assert.equal(w.createsAt(evidenceAddress(p)), 0);
});

test('with delivery evidence enabled the SettlementEvidence is published once and read back: the answer is delivered, and repeats and a restart send nothing', async (t) => {
  const w = await world(t, { deliveryEvidenceEnabled: true });
  const p = await w.purchase(), tx = p.pay(), address = evidenceAddress(p);
  const answer = await p.claim(tx);
  assert.equal(answer.delivery?.status, 'delivered', shown(answer));
  assert.equal(answer.delivery.evidencePublication, 'native-read-back');
  assert.equal(answer.delivery.evidenceRef.anchor.locator, address);
  assert.equal(w.createsAt(address), 1);
  assert.equal((await p.claim(tx)).delivery?.status, 'delivered');
  const again = await resumed(w, p);
  assert.equal(again.delivery?.status, 'delivered', shown(again));
  assert.equal(publishedEvidence(w), 1);
  assert.equal(w.createsAt(address), 1);
  assert.deepEqual(w.effects.deliverySubmit, [`dacs4:deliverable:${p.jobId}`], 'the Deliverable is sent once');
});

test('a delivery evidence CREATE whose answer was lost is only read back: held while the readback is unknown, then delivered with one CREATE, across a restart', async (t) => {
  const w = await world(t, { deliveryEvidenceEnabled: true });
  const p = await w.purchase(), tx = p.pay(), address = evidenceAddress(p);
  w.faults.artifactPublish.push('SettlementEvidence:land-throw');
  const lost = await p.claim(tx);
  assert.equal(lost.delivery?.status, 'delivery-ready', shown(lost));
  assert.equal(lost.delivery.evidencePublication, 'held-readback-only');
  assert.equal(w.createsAt(address), 1, 'the CREATE landed before the answer was lost');
  const evidenceCreate = w.signedCreate(address).hash;
  w.node.faults.transactionDown = (hash) => hash === evidenceCreate;
  const unknown = await p.claim(tx);
  assert.equal(unknown.delivery?.evidencePublication, 'held-readback-only', shown(unknown));
  assert.equal(publishedEvidence(w), 1, 'an unknown readback sends nothing');
  w.node.faults.transactionDown = () => false;
  await w.restart();
  const done = await p.claim(tx);
  assert.equal(done.delivery?.status, 'delivered', shown(done));
  assert.equal(publishedEvidence(w), 1, 'the CREATE was asked once');
  assert.equal(w.createsAt(address), 1);
  assert.equal(w.effects.deliverySubmit.length, 1);
});

test('a delivery evidence publication that never reached the wallet is published again, once', async (t) => {
  const w = await world(t, { deliveryEvidenceEnabled: true });
  const p = await w.purchase(), tx = p.pay(), address = evidenceAddress(p);
  w.faults.artifactPublish.push('SettlementEvidence');
  const held = await p.claim(tx);
  assert.equal(held.delivery?.evidencePublication, 'held-readback-only', shown(held));
  assert.equal(w.createsAt(address), 0, 'nothing was created');
  const done = await p.claim(tx);
  assert.equal(done.delivery?.status, 'delivered', shown(done));
  assert.equal(publishedEvidence(w), 1);
  assert.equal(w.createsAt(address), 1);
});

test('deterministic fixture job IDs stay distinct across independent worlds', async t=>{
  const first=await world(t),second=await world(t);
  assert.notEqual((await first.purchase()).jobId,(await second.purchase()).jobId);
});

test('the fixture node signs storage CREATEs with the fee and execution edits the pinned SDK writes', async () => {
  const node = demosNode(), writer = key(12);
  for (const artifact of [{ TEST: 'evidence' }, { TEST: 'e'.repeat(12_000) }]) {
    const { content } = node.create(writer, { logicalAddress: 'dacs4:payment:TEST-job:demos-native:DEM:2', artifact, artifactKind: 'SettlementEvidence' }, { land: false });
    assert.equal(await sdkRegeneratesSignedCreate(content), true, `${Buffer.byteLength(JSON.stringify(artifact))} bytes`);
  }
});

test('deterministic fixture transfers advance the payer nonce',()=>{
  const node=demosNode(),from=key(12).address,to=key(17).address,input={from,to,amountOs:'2500000000'};
  assert.notEqual(node.pay(input),node.pay(input));
  assert.equal(node.accountNonce(from),2);
});

test('a rejected signing answer with no retained CREATE recovers from the owning journal after restart',async t=>{
 const w=await world(t),p=await w.purchase(),tx=p.pay(),address=paymentAddress(p);w.faults.signCreate.push('invalid');
 const first=await p.claim(tx);assert.equal(first.status,'held');assert.equal(await w.walletJournal().readSignedProjection({logicalAddress:address}),null);
 await w.restart();const done=await p.claim(tx);assert.equal(done.status,'payment-evidenced',shown(done));assert.equal(w.effects.signCreate.length,2);assert.equal(w.createsAt(address),1);
});
test('an unreadable signing journal supplies no proof to release an unknown attempt',async t=>{
 const w=await world(t),p=await w.purchase(),tx=p.pay(),address=paymentAddress(p);w.walletJournal().close();
 assert.equal((await p.claim(tx)).status,'held');w.restartWallet();await w.restart();const again=await p.claim(tx);
 assert.equal(again.status,'held');assert.equal(w.effects.signCreate.length,0);assert.equal(w.createsAt(address),0);
});

for(const field of ['artifact','missing-artifact','projection','receipt'])test(`completed native delivery authenticates fresh ${field} before answering a repeated claim`,async t=>{
 const w=await world(t),p=await w.purchase(),tx=p.pay(),signed=await w.signedClaim(p,tx);
 const post=async()=>{const res=await fetch(`${w.host().url}/dacs/v1/payments`,{method:'POST',headers:{'content-type':'application/json',[SELLER_TRANSPORT_HEADER]:signed.header},body:signed.rawBody});assert.equal(res.status,200);return res.json();};
 assert.equal((await post()).delivery?.status,'delivery-ready');await w.restart();
 w.faults.deliveryRead=read=>{if(field==='artifact')read.artifact.body=['TEST different bytes'];else if(field==='missing-artifact')delete read.artifact;else if(field==='projection')read.signedProjection.content.nonce++;else read.receipt.evidence.value='TEST changed proof';return read;};
 assert.equal((await post()).delivery?.status,'held');assert.equal((await p.claim(tx)).delivery?.status,'held');
 w.faults.deliveryRead=null;assert.equal((await p.claim(tx)).delivery?.status,'delivery-ready');assert.equal(w.effects.deliverySubmit.length,1);
});
for(const size of [16385,131072])test(`a ${size}-byte Listing above the CREATE cap is refused before an Agreement or payment`,async t=>{
 const producer=input=>{const value=report({body:['']})(input);value.body[0]='a'.repeat(size-Buffer.byteLength(core.canonicalize(value)));return value;};
 const w=await world(t,{deliverableProducer:producer,deliverableExtension:{expectedSizeBytes:size}});
 const refused=await w.purchase({expectSigned:false});assert.equal(refused.disposition,'rejected');assert.match(refused.reason,/16384/);
 assert.equal(w.effects.componentSigns.filter(bytes=>[core.ARTIFACT_SEPARATORS.AgreementDocument,core.ARTIFACT_SEPARATORS.PayeeBoundAgreementDocument].some(separator=>bytes.startsWith(separator))).length,0);
 assert.equal(w.effects.deliverySubmit.length,0);assert.equal(w.effects.published.length,0);assert.equal(w.effects.signCreate.length,0);
 await w.restart();assert.equal((await w.purchase({expectSigned:false})).disposition,'rejected');
});

for(const restart of [false,true])test(`a corrected schema-invalid producer report keeps the same paid order retryable${restart?' after restart':''}`,async t=>{
 let valid=false;
 const schemaUrl='urn:TEST:correctable-schema',w=await world(t,{deliverableExtension:{schemaUrl},
  deliverableProducer:input=>report({mustHave:valid?'present':'missing'})(input),
  deliverySchemaVerifier:{schemaUrl,verify:({cleartextPayload})=>cleartextPayload.mustHave==='present'?{disposition:'valid'}:{disposition:'invalid',reason:'TEST schema rejects the current seller report'}}});
 const p=await w.purchase(),tx=p.pay();assert.equal((await p.claim(tx)).delivery?.status,'held');assert.equal(w.effects.deliverySubmit.length,0);
 if(restart)await w.restart();valid=true;
 const done=await p.claim(tx);assert.equal(done.delivery?.status,'delivery-ready',shown(done));
 assert.equal(w.effects.deliverySubmit.length,1);assert.equal(w.createsAt(paymentAddress(p)),1);
});

test('native integration claims use the filesystem-flow deadline and preserve its classified timeout cause',async t=>{
 const w=await world(t),p=await w.purchase(),tx=p.pay(),deadlines=[];
 t.mock.method(AbortSignal,'timeout',ms=>{deadlines.push(ms);return AbortSignal.abort(new DOMException('TEST deadline','TimeoutError'));});
 t.mock.method(globalThis,'fetch',async(_url,input)=>{throw input.signal.reason;});
 const answer=await p.claim(tx);
 assert.deepEqual({causeCode:answer.causeCode,timeoutMs:deadlines[0]},{causeCode:'timeout',timeoutMs:60_000});
});

for(const fault of ['malformed','malformed-valid','throw'])test(`a ${fault} schema answer leaves the paid report correctable`,async t=>{
 let available=false;const schemaUrl='urn:TEST:retryable-schema-answer';
 const w=await world(t,{deliverableExtension:{schemaUrl},deliverySchemaVerifier:{schemaUrl,verify:()=>{
  if(available)return{disposition:'valid'};if(fault==='throw')throw new Error('TEST schema reader stopped');return fault==='malformed-valid'?{disposition:'valid',extra:'TEST unexpected member'}:{disposition:'unknown'};
 }}}),p=await w.purchase(),tx=p.pay();
 assert.equal((await p.claim(tx)).delivery?.status,'held');assert.equal(w.effects.deliverySubmit.length,0);
 available=true;assert.equal((await p.claim(tx)).delivery?.status,'delivery-ready');assert.equal(w.effects.deliverySubmit.length,1);
});

test('one exact prepared candidate uses one successful schema verdict within the delivery run',async t=>{
 let calls=0;const schemaUrl='urn:TEST:single-candidate-check';
 const w=await world(t,{deliverableExtension:{schemaUrl},deliverySchemaVerifier:{schemaUrl,verify:()=>++calls===1?{disposition:'valid'}:{disposition:'invalid',reason:'TEST inconsistent second answer'}}});
 const p=await w.purchase(),done=await p.claim(p.pay());assert.equal(done.delivery?.status,'delivery-ready',shown(done));assert.equal(calls,1);
});

for(const failure of ['unavailable','changed'])test(`cached delivered claims reauthenticate ${failure} delivery evidence across restart`,async t=>{
 const w=await world(t,{deliveryEvidenceEnabled:true}),p=await w.purchase(),tx=p.pay(),signed=await w.signedClaim(p,tx),address=evidenceAddress(p);
 const post=async()=>{const res=await fetch(`${w.host().url}/dacs/v1/payments`,{method:'POST',headers:{'content-type':'application/json',[SELLER_TRANSPORT_HEADER]:signed.header},body:signed.rawBody});assert.equal(res.status,200);return res.json();};
 assert.equal((await post()).delivery?.status,'delivered');await w.restart();
 if(failure==='unavailable')w.node.faults.transactionDown=hash=>hash===w.signedCreate(address).hash;
 else w.faults.evidenceRead=read=>{read.receipt.transactionRef.value='e'.repeat(64);return read;};
 const held=await post();assert.notEqual(held.delivery?.status,'delivered');assert.equal(held.delivery?.evidencePublication,'held-readback-only',shown(held));
 w.node.faults.transactionDown=()=>false;w.faults.evidenceRead=null;assert.equal((await post()).delivery?.status,'delivered');assert.equal(w.createsAt(address),1);
});
test('delivery evidence returns its first authenticated receipt across later observations and restart',async t=>{
 const w=await world(t,{deliveryEvidenceEnabled:true}),p=await w.purchase(),tx=p.pay(),signed=await w.signedClaim(p,tx),address=evidenceAddress(p);
 const post=async()=>{const res=await fetch(`${w.host().url}/dacs/v1/payments`,{method:'POST',headers:{'content-type':'application/json',[SELLER_TRANSPORT_HEADER]:signed.header},body:signed.rawBody});assert.equal(res.status,200);return res.json();};
 const first=await post();assert.equal(first.delivery?.status,'delivered');const receipt=first.delivery.evidenceReceipt;
 w.node.faults.observedAt=receipt.observedAt+1;
 assert.deepEqual((await p.claim(tx)).delivery?.evidenceReceipt,receipt);await w.restart();
 assert.deepEqual((await post()).delivery?.evidenceReceipt,receipt);
 const saved=await w.retainedSession(p.jobId);assert.deepEqual(saved.deliveryEvidenceWork.receipt,receipt);assert.equal(w.createsAt(address),1);
});

for(const failure of ['none','unavailable','changed'])test(`disabling evidence publication preserves authenticated delivered facts with ${failure} readback after restart`,async t=>{
 const w=await world(t,{deliveryEvidenceEnabled:true}),p=await w.purchase(),tx=p.pay(),address=evidenceAddress(p);
 const first=await p.claim(tx);assert.equal(first.delivery?.status,'delivered',shown(first));
 const signed=await w.signedClaim(p,tx);await w.host().close();
 const off=await w.startShipped({deliveryEvidenceEnabled:false});t.after(()=>off.close());
 const post=async(request=signed)=>{const res=await fetch(`${off.url}/dacs/v1/payments`,{method:'POST',headers:{'content-type':'application/json',[SELLER_TRANSPORT_HEADER]:request.header},body:request.rawBody});assert.equal(res.status,200);return res.json();};
 if(failure==='unavailable')w.node.faults.transactionDown=hash=>hash===w.signedCreate(address).hash;
 if(failure==='changed')w.faults.evidenceRead=read=>{read.receipt.transactionRef.value='e'.repeat(64);return read;};
 const observed=await post();
 if(failure==='none')assert.equal(observed.delivery?.status,'delivered',shown(observed));
 else{assert.equal(observed.delivery?.status,'delivery-ready',shown(observed));assert.equal(observed.delivery?.evidencePublication,'held-readback-only');}
 w.node.faults.transactionDown=()=>false;w.faults.evidenceRead=null;
 for(const request of [signed,await w.signedClaim(p,tx)]){
  const done=await post(request);assert.equal(done.delivery?.status,'delivered',shown(done));
  assert.deepEqual(done.delivery.evidenceRef,first.delivery.evidenceRef);assert.deepEqual(done.delivery.evidenceReceipt,first.delivery.evidenceReceipt);
 }
 assert.equal(w.createsAt(address),1);assert.equal(w.effects.deliverySubmit.length,1);
});

test('disabling publication recovers an already landed evidence CREATE with a lost answer by readback',async t=>{
 const w=await world(t,{deliveryEvidenceEnabled:true}),p=await w.purchase(),tx=p.pay(),address=evidenceAddress(p);
 w.faults.artifactPublish.push('SettlementEvidence:land-throw');const held=await p.claim(tx);
 assert.equal(held.delivery?.evidencePublication,'held-readback-only');assert.equal(w.createsAt(address),1);
 const signed=await w.signedClaim(p,tx);await w.host().close();const off=await w.startShipped({deliveryEvidenceEnabled:false});t.after(()=>off.close());
 const response=await fetch(`${off.url}/dacs/v1/payments`,{method:'POST',headers:{'content-type':'application/json',[SELLER_TRANSPORT_HEADER]:signed.header},body:signed.rawBody});
 assert.equal(response.status,200);const done=await response.json();assert.equal(done.delivery?.status,'delivered',shown(done));
 assert.equal(done.delivery.evidenceRef.anchor.locator,address);assert.equal(w.createsAt(address),1);
});

test('disabling publication holds absent prior work without a new CREATE and enabling resumes it once',async t=>{
 const w=await world(t,{deliveryEvidenceEnabled:true}),p=await w.purchase(),tx=p.pay(),address=evidenceAddress(p);
 w.faults.artifactPublish.push('SettlementEvidence');assert.equal((await p.claim(tx)).delivery?.evidencePublication,'held-readback-only');assert.equal(w.createsAt(address),0);
 const signed=await w.signedClaim(p,tx);await w.host().close();let running=await w.startShipped({deliveryEvidenceEnabled:false});t.after(()=>running.close());
 const post=async()=>{const response=await fetch(`${running.url}/dacs/v1/payments`,{method:'POST',headers:{'content-type':'application/json',[SELLER_TRANSPORT_HEADER]:signed.header},body:signed.rawBody});assert.equal(response.status,200);return response.json();};
 for(let attempt=0;attempt<2;attempt++){const held=await post();assert.equal(held.delivery?.evidencePublication,'held-readback-only',shown(held));assert.equal(w.createsAt(address),0);}
 await running.close();running=await w.startShipped({deliveryEvidenceEnabled:true});assert.equal((await post()).delivery?.status,'delivered');assert.equal(w.createsAt(address),1);
});
