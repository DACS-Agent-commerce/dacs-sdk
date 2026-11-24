// Native purchases taken through the real public purchase and protocol factories, the shipped operations, approval
// challenge and coordinate stores, and a durable wallet journal: the buyer approves, the active handoff saves its
// coordinates and event, and the active lane read issues the one-time wallet guard. Only the verifier, the service's
// chain reads, the seller endpoint and the two fresh chain readbacks (retained-native-readback-stand-ins.mjs) are
// stand-ins. Import it after installing those stand-ins.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize, finalityCommitmentAddress, fixedPriceAgreementLogicalAddress, generateCanonicalJobId, logicalToStorageProgramName, sha256Hex } from '@kynesyslabs/dacs';
import { TESTNET_PROFILE_TP1 } from '@kynesyslabs/dacs/wire';
import * as client from '../../src/index.mjs';
import { createDevnetNativeCommitmentCapability } from '../../src/devnet-demo/commitment-consumer.mjs';
import { NATIVE_AGREEMENT_PAYMENT } from '../../src/dacs/native-agreement-payment-consumer.mjs';
import { SELLER_SR2_PUBLIC_PROJECTION } from '../../src/dacs/seller-sr2-agreement-consumer.mjs';
import { openDurableWalletJournal } from '../../src/wallet/durable-journal.mjs';
import { walletLane, walletLaneKey } from '../../src/wallet/wallet-lane.mjs';
import { passiveNativeWorld, IDENTITY, NOW } from './passive-native-world.mjs';
import { setPurchaseAdmission } from './wire-client-fixture.mjs';
import { createEphemeralWallet } from '../fixtures/wallet.mjs';
import { bindFixture, createAuthorityFixture } from '../fixtures/tp1-authority-reader.mjs';

export { IDENTITY, NOW };
const HANDOFF_SECRET = 'TEST-'.repeat(8);
const APPROVAL_ORIGIN = 'https://portal.example.invalid';
const APPROVAL_PURPOSE = 'approve-purchase';
const SELLER_ENDPOINT = 'https://seller.example.test';
const AUTHORITY = 'TEST-RUN-retained-lane0';
const LISTING_HASH = 'e'.repeat(64);
const PRICE = { amount: '2.5', amountOs: '2500000000' };
export const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

// A retained Agreement CREATE receipt that decodeDemosAnchorReceiptProof accepts, at a decimal-string nonce.
function anchorReceipt({ logicalAddress, writer, txHash, nonce }) {
  const proof = { proofVersion: '1', chainIdentity: IDENTITY, writer, operation: 'create', signedTransactionHash: sha256Hex(`TEST-signed:${txHash}`), finalityProofHash: sha256Hex(`TEST-final:${txHash}`),
    nativeRead: { programName: logicalToStorageProgramName(logicalAddress), valueHash: sha256Hex(`TEST-value:${txHash}`), observedAt: NOW - 120_000 } };
  return { receiptVersion: '1', substrate: 'demos', finalityProfile: 'demos-bft-confirmed-native-read', state: 'finalized', observationDisposition: 'established',
    logicalAddress, nativeAddress: `stor-${txHash.slice(0, 40)}`, contentHash: sha256Hex(`TEST-agreement:${txHash}`), transactionRef: { kind: 'demos-storage-program', value: txHash },
    writer, nonce: String(nonce), observedAt: NOW - 120_000, blockRef: { id: sha256Hex(`TEST-block:${txHash}`), height: '5', timestamp: NOW - 120_000 },
    evidence: { kind: 'demos-bft-write-proof-v1', value: Buffer.from(canonicalize(proof)).toString('base64url') } };
}

/**
 * Builds the world. `handoffTtlMs` is the operations store's handoff lifetime. Returns the stores, both public factories,
 * counters (stop reads, buyer access, seller lookups, identity reads, journal gets), the authority fixture, `seedCommitted`,
 * `handOff` (approval and handoff) and `issue(key, {createNonce})` (also the one-time guard), `compose(options)` and
 * `serviceWith(protocol)` for other compositions over the same stores, `holdJournalGet()`, `rows()` and `effects()`.
 * `stop`, `observedIdentity` and `chainNonce` are read live.
 */
export async function retainedLaneWorld(t, standIns, { handoffTtlMs = DAY_MS } = {}) {
  setPurchaseAdmission('testnet-tp1');
  t.after(() => setPurchaseAdmission('held'));
  const authority = createAuthorityFixture();
  const { binding, currentLocal } = await bindFixture({ readAuthority: async (scope) => ({ ...await authority.read(scope),
    participants: scope.participants.map((claim) => ({ claim, profile: binding.profile, modules: TESTNET_PROFILE_TP1.tuple })) }) });
  const admission = { binding, currentLocal };
  const wallet = createEphemeralWallet(), seller = createEphemeralWallet();
  const db = new DatabaseSync(':memory:');
  db.exec(client.PURCHASE_STATE_SCHEMA);
  const directory = mkdtempSync(join(tmpdir(), 'retained-native-lane-')), journalPath = join(directory, 'journal.sqlite');
  const durable = openDurableWalletJournal({ path: journalPath, mode: 'create' });
  t.after(() => { db.close(); durable.close(); rmSync(directory, { recursive: true, force: true }); });
  const native = passiveNativeWorld({ journal: durable });
  const store = client.createSqlitePurchaseStore(), now = () => NOW;
  const accounts = client.createLocalPurchaseAccount({ db, store, wallet: wallet.address, now });
  const ops = client.createPurchaseOperations({ db, store, handoffSecret: HANDOFF_SECRET, handoffTtlMs, now });
  const challenges = client.createPurchaseChallenges({ db, store, origin: APPROVAL_ORIGIN, purpose: APPROVAL_PURPOSE, ttlMs: 300_000, now });
  const coordinates = client.createCoordinateStore({ db, now });
  const counters = { stopReads: 0, buyerAccess: 0, sellerLookups: 0, identityReads: 0, journalGets: 0, broadcasts: 0 };
  let pendingGet = null;
  const journal = { ...native.journal, async get(key) {
    counters.journalGets++;
    if (pendingGet) { const hold = pendingGet; pendingGet = null; hold.entered(); await hold.released; }
    return native.journal.get(key);
  } };
  const world = { db, ops, coordinates, accountId: accounts.accountId, wallet, seller, native, journal, durable, journalPath, counters, standIns, stop: false, observedIdentity: IDENTITY, chainNonce: 0 };
  const chain = { network: 'testnet', pinnedIdentity: IDENTITY, getAddressBalance: async () => 10n ** 20n, getTransactionFees: async () => 1n,
    networkIdentity: async () => { counters.identityReads++; return { identity: world.observedIdentity, mode: 'public-chain-read' }; },
    getAddressNonce: async () => world.chainNonce, broadcastTransaction: async () => { counters.broadcasts++; } };
  const stopped = () => { counters.stopReads++; return world.stop; };
  const verifier = { verify: async () => ({ transactable: true, payee: seller.address, price: PRICE, contentHash: LISTING_HASH, checks: [], evidence: { chainMode: 'public-chain-read' } }) };
  const commitment = createDevnetNativeCommitmentCapability({ authority: AUTHORITY,
    anchor: { authority: AUTHORITY, readRetained() { throw new Error('TEST not used'); }, verifyReceipt() { throw new Error('TEST not used'); } } });
  const factoryOptions = ({ passiveOnly, withStop }) => ({ db, ops, coordinates, store, admission, now, ...(withStop ? { stopped } : {}),
    ...(passiveOnly ? { passiveOnly } : { feeCeilingOs: client.PAID_WRITE_FEE_CEILING_OS }) });
  // The public purchase service over these stores with `protocol`, which may be any object or null.
  world.serviceWith = (protocol, { passiveOnly = false, withStop = true } = {}) => client.createPurchaseService({ ...factoryOptions({ passiveOnly, withStop }), accounts, verifier, chain, protocol,
    challenges, purposes: { APPROVE_PURCHASE: APPROVAL_PURPOSE }, config: { demAmountEncoding: 'os-string', publicOrigin: APPROVAL_ORIGIN } });
  // Both public factories over these stores; `passiveOnly` omits the fee ceiling and the protocol's chain.
  world.compose = ({ passiveOnly = false, withStop = true } = {}) => {
    const protocol = client.createProtocolPurchases({ ...factoryOptions({ passiveOnly, withStop }), ...(passiveOnly ? {} : { chain }), buyerAccess: { assertWallet() { counters.buyerAccess++; } },
      dacsProtocol: { walletAgreement: { sourceCapability: native.source, network: 'testnet', rpcUrl: native.source.pins.endpoint, journal, bridgeFor: () => ({}) },
        nativeSellerCommitment: commitment, nativeAgreementPayment: native.source, sellerEndpoint: () => { counters.sellerLookups++; return SELLER_ENDPOINT; } } });
    return { protocol, service: world.serviceWith(protocol, { passiveOnly, withStop }) };
  };
  Object.assign(world, world.compose(), { authority });

  // A native purchase in `status` with its retained Agreement and seller commitment, as commitment readback leaves it,
  // and its CREATE's broadcast-accepted wallet lane at `createNonce`.
  world.seedCommitted = async (key, { status = 'awaiting_approval', createNonce = 1, expiresAt = iso(NOW + 1_800_000) } = {}) => {
    const jobId = generateCanonicalJobId(), logicalAddress = fixedPriceAgreementLogicalAddress(jobId), txHash = sha256Hex(`TEST-create:${key}`);
    const receipt = anchorReceipt({ logicalAddress, writer: wallet.claim, txHash, nonce: createNonce });
    const terms = { buyer: { accountId: world.accountId, wallet: wallet.address }, seller: { claim: seller.claim, payee: seller.address }, price: PRICE, network: 'testnet', rail: 'demos-native:DEM',
      listing: { listingId: 'TEST-listing', version: 1, contentHash: LISTING_HASH }, domain: { network: 'testnet', rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: IDENTITY },
      protocol: { profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1', nativePayment: NATIVE_AGREEMENT_PAYMENT, sellerAgreementProjection: SELLER_SR2_PUBLIC_PROJECTION, jobId, transportBinding: native.source.transportBinding } };
    const commitmentAddress = finalityCommitmentAddress(jobId);
    const sellerCommitment = { address: commitmentAddress, contentHash: sha256Hex(`TEST-commitment:${key}`), signer: seller.claim, committedAt: iso(NOW - 90_000), verifiedAt: iso(NOW - 60_000), substrate: 'source-native-one-node' };
    const agreement = { artifact: { jobId }, hash: receipt.contentHash, ref: { anchor: { kind: 'storage-program', locator: logicalAddress }, contentHash: receipt.contentHash },
      anchorReceipt: receipt, signedProjection: { hash: txHash }, terms: { payee: seller.address, price: { amountOs: PRICE.amountOs } } };
    const state = { preparedVerification: { evidence: { chainMode: 'public-chain-read' } },
      protocol: { stage: 'seller-committed', agreement, commitment: sellerCommitment, chainReadback: { [commitmentAddress]: { hash: sha256Hex(`TEST-commit-create:${key}`) } } } };
    const { operation } = ops.createIdempotent({ accountId: world.accountId, kind: 'purchase', idempotencyKey: key, request: { key }, status, terms, termsHash: sha256Hex(`TEST-terms:${key}`), state, expiresAt, jobId });
    standIns.agreements.set(logicalAddress, receipt);
    standIns.commitments.set(jobId, { contentHash: sellerCommitment.contentHash, signer: sellerCommitment.signer, committedAt: sellerCommitment.committedAt });
    const lane = walletLane({ network: 'testnet', chainIdentity: IDENTITY, address: wallet.address });
    await journal.put(walletLaneKey(lane), { lane, stage: 'broadcast-accepted', nonce: createNonce, hash: txHash, signedTransaction: { hash: txHash, content: { from: wallet.address, nonce: createNonce } } });
    world.chainNonce = createNonce;
    return { operationId: operation.id, token: ops.handoffTokenFor(operation.id), key: lane, txHash, createNonce };
  };

  // The buyer approves and the active handoff runs, as the portal calls it; the guard is not yet issued.
  world.handOff = async (key, options) => {
    const purchase = await world.seedCommitted(key, options);
    const request = { operationId: purchase.operationId, token: purchase.token };
    const challenge = await world.service.issueApprovalChallenge({ ...request, address: wallet.address });
    const handoff = await world.service.approve({ ...request, challengeId: challenge.challengeId, signature: wallet.signHex(challenge.message) });
    if (!handoff.payload) throw new Error(`TEST handoff refused: ${handoff.refused ?? handoff.operation.status}`);
    const stored = ops.get(world.accountId, purchase.operationId);
    const handoffEvent = ops.history(purchase.operationId).findLast((event) => event.type === 'payment_handoff');
    if (handoffEvent?.data.sellerCommitmentWitness !== sha256Hex(canonicalize(stored.state.protocol.commitment))) throw new Error('TEST handoff event has no seller commitment witness');
    return purchase;
  };

  // After the handoff, the active lane read issues the one-time wallet guard once.
  world.issue = async (key, options) => {
    const purchase = await world.handOff(key, options);
    const request = { operationId: purchase.operationId, token: purchase.token };
    const guard = await world.service.nativePaymentLane({ ...request, key: purchase.key });
    const issued = ops.get(world.accountId, purchase.operationId);
    const issuance = ops.history(purchase.operationId).findLast((event) => event.type === 'protocol_native_wallet_guard_issued');
    if (issued.state.protocol.nativePaymentLaneIssued !== true || issuance?.data.createHash !== purchase.txHash || guard.record.hash !== purchase.txHash || guard.record.nonce !== purchase.createNonce) {
      throw new Error('TEST the one-time wallet guard was not issued');
    }
    return { ...purchase, guard: guard.record, expectedNonce: coordinates.get(purchase.operationId).expectedNonce };
  };

  // The next journal get signals `entered` and waits for `release()`.
  world.holdJournalGet = () => {
    let entered, release;
    const hold = { entered: null, released: new Promise((resolve) => { release = resolve; }) };
    const reached = new Promise((resolve) => { entered = resolve; });
    hold.entered = entered;
    pendingGet = hold;
    return { reached, release };
  };
  world.rows = () => JSON.stringify(['operations', 'operation_events', 'write_coordinates', 'approvals', 'challenges', 'wallet_nonce_consumptions']
    .map((name) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
  world.effects = () => ({ stopReads: counters.stopReads, sellerLookups: counters.sellerLookups, broadcasts: counters.broadcasts, journalWrites: native.writes.length, nodeCalls: native.calls.length,
    agreementReads: standIns.reads.agreement, commitmentReads: standIns.reads.commitment });
  return world;
}
