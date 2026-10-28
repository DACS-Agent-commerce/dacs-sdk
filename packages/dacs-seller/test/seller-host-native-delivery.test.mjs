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
import assert from 'node:assert/strict';
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
import { createSessionAdmissionFixture } from './helpers/session-admission-fixture.mjs';
import {finalizedCommitmentReader} from './helpers/finalized-commitment-reader.mjs';
import { sdkRegeneratesSignedCreate } from './helpers/payment-evidence-wallet-sdk.mjs';

const deliveryStaged=true; // Native delivery is staged in this part.
const assertDeliveryStage=(answer,w)=>{if(deliveryStaged){assert.equal(answer.delivery.status,'held');assert.equal(w.effects.deliverySubmit.length,0);}else assert.ok(['held','delivery-ready','delivered'].includes(answer.delivery.status));};
let jobSequence=0;
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
  const reader = createDemosSr2Adapter({ rpcUrl: RPC, journal: createInMemoryDemosSr2Journal(), fetchImpl });
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
async function world(t, { deliverableProducer = null, schemaUrl = true, reconcile = true, projectionReader = true, sellerPresentation = null, deliverableExtension = {}, deliverySchemaVerifier = undefined, maxJobs = 10000, deliveryEvidenceEnabled = false, compatibilityObserver = true, idempotentArtifacts = true, omitExpectedSize = false, buyerAccessOptions = { openBuyerAccess: true } } = {}) {
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
  const effects = { deliverySubmit: [], published: [], signCreate: [], signed: [], broadcast: [], componentSigns: [] };
  const faults = { deliverySubmit: [], signCreate: [], broadcast: [], readAccountNonce: [], sign: [], beforeDeliveryReconcile: async () => {}, agreementRead: [], artifactPublish: [], artifactRead: [] };
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
      const read = await readBack(logicalAddress, artifactKind);
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
  const restartWallet = () => { journal.close(); journal = openJournal(); };
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
  const nativeDemDelivery=createNativeDemDeliveryCapability({authority:'TEST-host-native-delivery',...Object.fromEntries(['submit','reconcile','read','verifyReceipt'].map(name=>[name,()=>{throw new Error('TEST native delivery is not assembled');}]))});
  const producer = deliverableProducer ?? report();

  const dataDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'seller-host-native-')));
  const rails = { authority: steward.railAuthority() };
  const hosts = [];
  t.after(async () => {try{for (const host of hosts) await host.close();}finally{journal.close();rmSync(dataDirectory,{recursive:true,force:true});rmSync(walletDirectory,{recursive:true,force:true});} });
  const capabilities = () => ({ signer: sellerSigner, listing,
    buyerAccess: seller.createOperatorBuyerAccess({ buyerForJob: jobId => buyerBundles.has(jobId) ? buyerKey.address : null, ...buyerAccessOptions }), agreementAnchor, deliverableProducer: producer, maxJobs, deliveryEvidenceEnabled,
    deliverySchemaVerifier: deliverySchemaVerifier ?? { schemaUrl: listing.offering.deliverable.schemaUrl, verify: ({ cleartextPayload: p }) => ({ disposition: p.reportVersion === '1' && typeof p.kind === 'string' && Array.isArray(p.body) && p.body.every(v => typeof v === 'string') ? 'valid' : 'invalid' }) },
    ...(compatibilityObserver ? { observeDemosTransfer: async () => { throw new Error('TEST the native profile observes transfers through native payment evidence'); } } : {}),
    nativePaymentEvidence: evidenceConsumer(journal.anchorEvidence), demDeliveryContext, nativeDemDelivery, railAuthority: rails.authority,
    sessionAdmission: admission.sessionAdmission, now: clock, ...(reconcile ? { reconcilePaymentEvidence: journal.reconcilePaymentEvidence } : {}) });
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
    const client = () => seller.createSellerAgentClient({ url: host.url, authentication: seller.createSellerTransportClientAuth({
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
        catch (error) { return { error: error.code, status: error.status }; } } };
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
  const createsAt = (logicalAddress) => node.creates.filter((entry) => entry.logicalAddress === logicalAddress).length;
  const signedCreate = (logicalAddress) => clone(signedCreates.get(logicalAddress));
  const writtenAt = (logicalAddress) => clone(written.get(logicalAddress));
  return { node, effects, faults, purchase, restart, restartWallet, replaceWallet, retainedSession, crashMidClaim, startShipped, evidenceConsumer, openJournal, walletJournal: () => journal,
    host: () => host, capabilities, dataDirectory, createsAt, signedCreate, writtenAt, sellerKey, buyerKey, listing, rails, otherRail: () => railSteward().railAuthority(), editRetainedSession };
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
      if(held.status==='held')assert.equal(held.readback,'indeterminate');else assert.equal(held.delivery.status,'held');
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
    assert.equal(w.createsAt(address), 0, 'a thrown signing call has no landed CREATE');
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
  assert.equal(pending.status, 'payment-evidenced', 'the retained CREATE is freshly authenticated after broadcast');
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
    assert.equal(held.status, 'held', `claim ${claim}: ${shown(held)}`);
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
  assert.equal(work.journalVersion, 1, 'the owning journal decides supersession under its lock');
  assert.equal(work.anchorAnswer.txHash, w.signedCreate(address).hash);
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
test('the package builds capabilities only for the loopback fixture node and TEST authorities: a real node endpoint and an unregistered source are refused', () => {
  for (const rpcUrl of ['https://node2.demos.sh/', 'http://node2.demos.sh/', 'http://localhost:53550/', 'http://127.0.0.1:9/node']) {
    assert.throws(() => createNativePaymentEvidenceConsumer({ rpcUrl }), { name: 'TypeError', message: /owned literal loopback or the exact opaque source/ }, rpcUrl);
  }
  assert.throws(() => createNativePaymentEvidenceConsumer({ rpcUrl: 'https://node2.demos.sh/', sourceCapability: {} }), { name: 'TypeError', message: /exact opaque SettlementEvidence source capability/ });
  const operations = { submit: async () => null, reconcile: async () => null, read: async () => null, verifyReceipt: async () => null };
  assert.throws(() => createNativeDemDeliveryCapability({ authority: 'node2.demos.sh', ...operations }), { name: 'TypeError', message: /explicit TEST authority/ });
  assert.doesNotThrow(() => createNativeDemDeliveryCapability({ authority: 'TEST-scope', ...operations }));
});



for(const value of [undefined,null,0,{}])test(`missing or malformed journal identity ${JSON.stringify(value)} cannot release another journal's pending CREATE`,async t=>{
 const w=await world(t,{projectionReader:false}),p=await w.purchase(),tx=p.pay(),address=paymentAddress(p),name=core.logicalToStorageProgramName(address);w.node.faults.transactionDown=hash=>hash===w.signedCreate(address)?.hash;w.node.faults.indexEmpty=program=>program===name;w.faults.broadcast.push('lost');assert.equal((await p.claim(tx)).status,'held');await w.editRetainedSession(p.jobId,session=>{if(value===undefined)delete session.nativeEvidenceWork.walletJournal;else session.nativeEvidenceWork.walletJournal=value;});await w.host().close();w.replaceWallet('TEST-replacement.sqlite');await w.restart();w.node.faults.transactionDown=()=>false;for(let i=0;i<2;i++)assert.notEqual((await p.claim(tx)).status,'payment-evidenced');assert.equal(w.createsAt(address),1);assert.equal(w.effects.signCreate.filter(x=>x===address).length,1);
});
for(const damage of ['proof','order','deliveryReady','ambiguous'])test(`authenticated checkpoint ${damage} cannot return unauthenticated evidence or run unassembled delivery`,{skip:!deliveryStaged&&['deliveryReady','ambiguous'].includes(damage)},async t=>{
 const w=await world(t),p=await w.purchase(),tx=p.pay();assert.equal((await p.claim(tx)).status,'payment-evidenced');await w.editRetainedSession(p.jobId,session=>{
  const work=session.nativeEvidenceWork;if(damage==='proof')work.nativeReceipt.evidence.value='TEST-broken-proof';else if(damage==='order'){const projection=JSON.parse(work.publicSignedProjectionJson);projection.content=Object.fromEntries(Object.entries(projection.content).reverse());work.publicSignedProjectionJson=JSON.stringify(projection);}else if(damage==='deliveryReady')session.deliveryReady={status:'delivery-ready'};else session.deliveryHold={result:{code:'delivery-submission-ambiguous'}};
 });const answer=await p.claim(tx);
 if(['proof','order'].includes(damage))assert.notEqual(answer.status,'payment-evidenced');else{assert.equal(answer.status,'payment-evidenced',shown(answer));assert.equal(answer.delivery.status,'held');}
 assert.equal(w.effects.deliverySubmit.length,0);assert.equal(w.createsAt(paymentAddress(p)),1);
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
test('an unreadable signing journal holds only until its original owner recovers',async t=>{
 const w=await world(t),p=await w.purchase(),tx=p.pay(),address=paymentAddress(p);w.walletJournal().close();
 assert.equal((await p.claim(tx)).status,'held');w.restartWallet();await w.restart();const again=await p.claim(tx);
 assert.equal(again.status,'payment-evidenced',shown(again));assert.equal(w.effects.signCreate.length,1);assert.equal(w.createsAt(address),1);
});

for(const projectionReader of [false,true])for(const code of ['SQLITE_BUSY','SQLITE_IOERR','resolver-timeout'])test(`rejected signing and ${code} projection read recover through the same owner, consumer reader=${projectionReader}`,async t=>{
 const w=await world(t,{projectionReader}),p=await w.purchase(),tx=p.pay(),address=paymentAddress(p);w.faults.signCreate.push('throw');
 const prepare=DatabaseSync.prototype.prepare;
 DatabaseSync.prototype.prepare=function(sql,...args){if(sql==='SELECT signed_transaction FROM evidence_creates WHERE logical_address = ? AND superseded_at IS NULL'&&w.effects.signCreate.length>0)throw Object.assign(new Error('TEST temporary projection storage failure'),{code});return prepare.call(this,sql,...args);};
 let first;try{first=await p.claim(tx);}finally{DatabaseSync.prototype.prepare=prepare;}
 assert.equal(first.status,'held',shown(first));assert.equal(first.nativeReadCode,code);assert.equal(w.effects.signCreate.length,1);assert.equal(w.createsAt(address),0);
 w.restartWallet();await w.restart();const done=await p.claim(tx);assert.equal(done.status,'payment-evidenced',shown(done));assertDeliveryStage(done,w);
 assert.equal(w.effects.signCreate.length,2);assert.equal(w.createsAt(address),1);
});

test('an unchanged owner recovers a retained unknown checkpoint without catch-time unsigned permission',async t=>{
 const w=await world(t,{projectionReader:false}),p=await w.purchase(),tx=p.pay(),address=paymentAddress(p);w.faults.signCreate.push('throw');assert.equal((await p.claim(tx)).status,'held');
 await w.editRetainedSession(p.jobId,session=>{session.nativeEvidenceWork.anchorOutcome='unknown';delete session.nativeEvidenceWork.journalVersion;delete session.nativeEvidenceWork.anchorAnswer;});
 w.restartWallet();await w.restart();const done=await p.claim(tx);assert.equal(done.status,'payment-evidenced',shown(done));assert.equal(w.createsAt(address),1);assertDeliveryStage(done,w);
});

for(const [kind,fault] of [['signCreate','throw'],['broadcast','drop']])test(`a missing evidence artifact cannot ${kind==='signCreate'?'sign':'rebroadcast'} while the original transfer is unverified`,async t=>{
 const w=await world(t),p=await w.purchase(),tx=p.pay(),address=paymentAddress(p);w.faults[kind].push(fault);assert.equal((await p.claim(tx)).status,'held');
 const signed=w.effects.signCreate.length,broadcasts=w.effects.broadcast.length;w.node.faults.transactionDown=hash=>hash===tx;
 const retry=await p.claim(tx);assert.equal(retry.status,'held',shown(retry));assert.equal(retry.anchorError?.code,'payment_readback_required');
 assert.equal(w.effects.signCreate.length,signed);assert.equal(w.effects.broadcast.length,broadcasts);assert.equal(w.createsAt(address),0);
 w.node.faults.transactionDown=()=>false;await w.restart();const done=await p.claim(tx);assert.equal(done.status,'payment-evidenced',shown(done));assert.equal(w.createsAt(address),1);assertDeliveryStage(done,w);
});

test('a plain evidence signer failure preserves its bounded stage before any wallet effect',async t=>{
 const w=await world(t),p=await w.purchase(),tx=p.pay();w.faults.sign.push('throw-evidence');const answer=await p.claim(tx);
 assert.equal(answer.status,'indeterminate',shown(answer));assert.equal(answer.step,'evidence-signing');assert.equal(answer.cause,'evidence-signing-failed');assert.equal(w.effects.signCreate.length,0);assert.equal(w.effects.deliverySubmit.length,0);
});
