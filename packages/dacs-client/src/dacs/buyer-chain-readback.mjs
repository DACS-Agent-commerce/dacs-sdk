import { commitmentContradicted, commitmentRecordContradicts } from '../devnet-demo/commitment-consumer.mjs';
// Buyer-side chain readback of the seller's FinalityCommitmentRecord,
// Deliverable and delivery SettlementEvidence (chain readback only).
// It replaces the devnet readers that ask the in-process seller's artifact
// journal (commitment-consumer.mjs and native-delivery.mjs readRetained), which
// a seller in its own process does not share.
//
// The only authorities are the buyer's own pinned source transport, the seller
// key named by the verified Listing, the buyer's own Agreement and the canonical
// logical addresses derived from its job. The seller's answer supplies just the
// original public signed CREATE bytes, which Node2 does not return unchanged
// (executed fields are normalized, so their hash no longer matches). Those bytes
// stay seller data until the existing read-only SR-2 adapter authenticates them
// against the chain: their hash, the Listing seller's signature, the executed
// transaction and its block, and the one native program the seller owns at the
// canonical logical address, with its exact bytes, kind and binding.
//
// A Demos `not found` is not proof of absence (DEMOS-MAPPING): a missing
// pointer, an empty name index or an unavailable read is indeterminate, never
// absent, and the normal poll reads again. Only a verified commitment is reused,
// briefly and before payment only. Nothing here writes, signs or sends.
//
// Scope: this is about verification. The devnet operator still gates a run on
// its co-resident seller (the buyer driver binds with the seller composition's
// Listing, and reconcileSellerEvidenceLane reads the seller wallet journal
// before a run); neither verifies anything for the buyer. Both move with the
// seller kit (P6).
import { isCanonicalJobId, canonicalize, commitFixedPriceAgreement, contentHash, DacsError, faultCategory, finalityCommitmentAddress, NotImplementedError, sha256Hex, UnsupportedCapabilityError } from '@kynesyslabs/dacs';
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal, demosSr2TxRef, isDemosSr2Contradiction } from './demos-sr2-adapter.mjs';
import { isNativeDeliveryEvidence } from './delivery-evidence.mjs';
import { commitmentSession, commitmentVerifier, deliverableAddress, deliveryEvidenceAddress, listingPin, plainJson } from './purchase-protocol.mjs';
import { isDevnetPurchasedReport } from '../devnet-demo/deliverable.mjs';
import { isDevnetAgreementTransport } from '../wallet/devnet-native-transport.mjs';
import { addressForClaim } from '../signatures.mjs';
import { createImmutableReadbacks } from '../util/immutable-readbacks.mjs';

export const BUYER_CHAIN_READBACK_SOURCE = 'dacs-chatgpt-plugin/buyer-chain-readback/v1';
const HASH = /^[0-9a-f]{64}$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const held = (status, reason) => ({ status, reason: String(reason).slice(0, 240) });
const same = (left, right) => { try { return canonicalize(left) === canonicalize(right); } catch { return false; } };
// No signed CREATE bytes to authenticate: unknown, and marked so a caller can
// tell "no pointer yet" from a chain read that did not verify.
export const POINTER_MISSING = 'signed-create-missing';
const missing = (artifactKind) => ({ ...held('indeterminate', `the original signed ${artifactKind} CREATE is not available yet; nothing is inferred from its absence`), pointer: POINTER_MISSING });
// A rejection the chain itself established (`authenticated`): the offered bytes
// authenticated (signature, executed transaction, block and native program) and
// what reads back differs. A caller may lower a verified result on this, or on
// a rejection of bytes it had already authenticated and kept; a rejection of
// seller-offered bytes that never authenticated proves nothing about the chain.
const untrusted = (reason) => ({ ...held('indeterminate', reason), sellerAnswerDiagnostic: reason });
const contradicted = (reason) => ({ ...held('rejected', reason), authenticated: true });

// Exceptions are classified by an explicit allowlist; anything else is
// indeterminate and the normal poll reads again. A read's `invalid` is the
// SR-2 adapter's definite verdict only when it is marked as a contradiction
// (the source change: the exact writer's signed CREATE authenticated and contradicts what the
// buyer pinned). An unmarked `invalid` is node data, or offered bytes, that did
// not authenticate: indeterminate, with its code kept so a caller can tell
// seller-offered bytes that failed from an unavailable read (whose bytes they
// were decides whom it blames; see protocol-purchases.mjs). `indeterminate`,
// `invalid-chain` (the node reports another chain), any other code, or no code
// at all (a local or transport fault) proves nothing. In the SDK's commitment resume only a counterparty
// fault (an invalid signature) or a plain permanent DacsError (its verdict that
// the authenticated record, Agreement and Listing do not form this commitment)
// is a contradiction. A SubstrateError, such as the receipt proof re-read coming
// back indeterminate (a 503, or a fence refused at the source change's shutdown drain), a
// transient or foreign error, and a local capability boundary
// (UnsupportedCapabilityError, NotImplementedError) are not.
export const CONTRADICTED_READ_CODES = Object.freeze(['invalid']);
export const CONTRADICTED_SDK_CATEGORIES = Object.freeze(['counterparty', 'permanent']);
const readContradicts = (error) => CONTRADICTED_READ_CODES.includes(error?.code) && isDemosSr2Contradiction(error);


// Startup refusal: a configured capability
// that can only verify through a seller's journal is never kept silently.
export class BuyerChainReadbackUnsupported extends TypeError {
  constructor(message) { super(message); this.name = 'BuyerChainReadbackUnsupported'; this.code = 'buyer_chain_readback_unsupported'; }
}

// Only the signed fields of an offered CREATE: its hash, the content the hash
// is over, the signature over the hash and a non-empty dual signature (part of
// the proof hash). Unsigned extras such as status or blockNumber are dropped.
export function signedCreateBytes(projection) {
  if (!object(projection)) return undefined;
  const { hash, content, signature, ed25519_signature: dual } = projection;
  return plainJson({ hash, content, signature, ...(dual !== undefined && dual !== null && dual !== '' ? { ed25519_signature: dual } : {}) });
}

// `reader` is injectable for an already constructed adapter exposing the same
// read/verifyReceipt contract; by default one is built over the source pin with
// a read-only, empty journal, so no seller or buyer plan is ever inherited.
export function createBuyerChainReadback({ sourceCapability, now = () => Date.now(), reader } = {}) {
  if (!isDevnetAgreementTransport(sourceCapability) || typeof sourceCapability.observeBinding !== 'function') throw new BuyerChainReadbackUnsupported('buyer chain readback requires the buyer\'s own pinned source transport');
  const adapter = reader ?? createDemosSr2Adapter({ rpcUrl: sourceCapability.pins.endpoint, sourceCapability, now,
    journal: { ...createInMemoryDemosSr2Journal(), put: async () => { throw new Error('the buyer chain reader is read-only'); } } });
  if (typeof adapter?.read !== 'function' || typeof adapter.verifyReceipt !== 'function') throw new TypeError('an SR-2 reader with read and verifyReceipt is required');
  const immutable = createImmutableReadbacks({ now });

  // The expected writer is the verified Listing's seller key and nothing else.
  function writerFor(listing, seller) {
    const writer = listing?.seller?.identity?.presentedBy;
    return typeof writer === 'string' && writer === seller ? writer : null;
  }

  // One authenticated native record at the canonical address, or why not.
  async function authenticated({ logicalAddress, writer, artifactKind, deliveryBinding, signedProjection: offered }) {
    const signedProjection = signedCreateBytes(offered);
    if (!object(signedProjection) || !object(signedProjection.content) || !HASH.test(signedProjection.hash ?? '')) return missing(artifactKind);
    // The pointer must name this writer, address and kind before any read.
    const op = signedProjection.content.data?.[1];
    let owner;
    try { owner = addressForClaim(writer); } catch { owner = null; }
    if (!owner || signedProjection.content.from !== owner) return untrusted(`the supplied ${artifactKind} CREATE is not signed by the Listing seller`);
    if (op?.metadata?.logicalAddress !== logicalAddress || op.metadata.artifactKind !== artifactKind) return untrusted(`the supplied ${artifactKind} CREATE names another logical address or kind`);
    let record;
    try {
      record = await adapter.read(logicalAddress, { expectedWriter: writer, expectedArtifactKind: artifactKind, ...(deliveryBinding ? { expectedDeliveryBinding: deliveryBinding } : {}), signedProjection });
    } catch (error) {
      const reason = `native ${artifactKind} read: ${error?.code ?? 'error'}: ${error?.message ?? error}`;
      return readContradicts(error) ? contradicted(reason) : { ...held('indeterminate', reason), ...(CONTRADICTED_READ_CODES.includes(error?.code) ? { code: error.code } : {}) };
    }
    // Not found at the canonical address: unknown, not absent.
    if (record?.status === 'absent') return held('indeterminate', `no native ${artifactKind} is visible at the canonical address yet; a Demos not-found is not proof of absence`);
    if (record?.status !== 'present' || !object(record.receipt) || !object(record.artifact)) return held('indeterminate', `native ${artifactKind} read returned no exact record`);
    // From here the offered bytes have authenticated on chain: a rejection is
    // about what they read back.
    const hash = contentHash(record.artifact);
    if (record.artifactKind !== artifactKind || record.receipt.writer !== writer || record.receipt.logicalAddress !== logicalAddress
        || record.receipt.contentHash !== hash || record.receipt.transactionRef?.value !== signedProjection.hash || record.receipt.nativeAddress !== signedProjection.content.to) {
      return contradicted(`native ${artifactKind} readback differs in writer, address, kind or content hash`);
    }
    let verdict;
    try {
      verdict = await adapter.verifyReceipt({ receipt: record.receipt, logicalAddress, artifact: record.artifact, expectedWriter: writer, artifactKind,
        ...(deliveryBinding ? { deliveryBinding } : {}), receiptContentHash: hash, signedProjection });
    } catch (error) {
      const reason = `native ${artifactKind} receipt: ${error?.code ?? 'error'}: ${error?.message ?? error}`;
      return readContradicts(error) ? contradicted(reason) : { ...held('indeterminate', reason), ...(error?.code ? { code: error.code } : {}) };
    }
    if (verdict !== 'valid') return verdict === 'invalid' ? contradicted(`native ${artifactKind} receipt is ${verdict}`) : held('indeterminate', `native ${artifactKind} receipt is ${verdict}`);
    return { status: 'present', artifact: record.artifact, receipt: record.receipt, signedProjection, demosEvidence: record.demosEvidence };
  }

  // fresh: the payment-path gates never reuse; other callers may reuse this
  // purchase's own verified commitment for the short TTL. Only a verified
  // result is kept, keyed by every input including the exact projection bytes.
  async function readCommitment({ agreement: rawAgreement, listing: rawListing, seller, signedProjection: offered, fresh = false }) {
    if (!isCanonicalJobId(rawAgreement?.jobId)) return untrusted('canonical JID-1 jobId required');
    const signedProjection = signedCreateBytes(offered);
    const agreement = plainJson(rawAgreement), listing = plainJson(rawListing), session = commitmentSession(agreement), address = finalityCommitmentAddress(agreement.jobId);
    const writer = writerFor(listing, seller);
    if (!writer || session.orchestrator !== writer) return { ...untrusted('the commitment writer is not the verified Listing seller'), address };
    const cacheKey = { purchaseId: agreement.jobId, locator: address, contentHash: contentHash(agreement),
      scope: { agreement, listing: listingPin(listing), writer, binding: sourceCapability.transportBinding, projection: signedProjection ?? null, projectionBytes: sha256Hex(JSON.stringify(signedProjection ?? null)) } };
    const cached = fresh ? null : immutable.get(cacheKey);
    if (cached) { await sourceCapability.observeBinding(); return cached; }
    const read = await authenticated({ logicalAddress: address, writer, artifactKind: 'FinalityCommitmentRecord', signedProjection });
    if (read.status !== 'present') { immutable.delete(cacheKey); return { ...read, address }; }
    const refuse = () => { throw new Error('the buyer never signs or submits a commitment'); };
    let receiptContradicted = false;
    try {
      const finalized = await commitFixedPriceAgreement({ agreement, verifiedListing: { disposition: 'verified', listing, pin: listingPin(listing) }, session, createdAt: now(),
        commitmentSigner: { algorithm: 'ed25519', signer: session.orchestrator, sign: refuse } }, {
        resolve: async () => ({ disposition: 'present', anchored: { record: read.artifact, nativeAddress: read.receipt.nativeAddress, anchorTxRef: demosSr2TxRef(read.receipt), anchorReceipt: read.receipt } }),
        verifyAnchorReceipt: async (anchored) => {
          const verdict = await adapter.verifyReceipt({ receipt: anchored.anchorReceipt, logicalAddress: address, artifact: anchored.record, expectedWriter: writer,
          artifactKind: 'FinalityCommitmentRecord', receiptContentHash: contentHash(anchored.record), signedProjection });
          if (verdict === 'invalid') receiptContradicted = true;
          return verdict;
        },
        submit: refuse,
      }, commitmentVerifier);
      if (!finalized.resumed || finalized.recordKind !== 'finality' || finalized.record.signature?.signer !== writer) { immutable.delete(cacheKey); return { ...contradicted('commitment was not resumed from native readback'), address }; }
      const verified = { status: 'verified', address, ref: { anchor: { kind: 'storage-program', locator: address }, contentHash: contentHash(finalized.record), signer: session.orchestrator },
        contentHash: contentHash(finalized.record), signer: finalized.record.signature.signer, committedAt: finalized.committedAt, anchorReceipt: finalized.anchorReceipt,
        substrate: 'source-native-one-node', chainSignedCreate: read.signedProjection };
      immutable.put(cacheKey, verified);
      return verified;
    } catch (error) {
      immutable.delete(cacheKey);
      const reason = `commitment resume: ${error?.name ?? 'error'}: ${error?.message ?? error}`;
      return { ...(commitmentContradicted(error, { receiptContradicted, recordContradicted: commitmentRecordContradicts(read.artifact, {agreement, listing, session}) }) ? contradicted(reason) : held('indeterminate', reason)), address };
    }
  }

  // The buyer derives the binding from its own Agreement and Listing; the
  // seller's pointer contributes only the fulfilment id and payload hash it
  // claims, and both must match the bytes that read back.
  async function readDeliverable({ jobId, agreementHash, listing, seller, deliveryBinding, receiptContentHash, settlementId, signedProjection }) {
    if (!isCanonicalJobId(jobId)) return untrusted('canonical JID-1 jobId required');
    const writer = writerFor(listing, seller), logicalAddress = deliverableAddress(jobId);
    if (!writer) return untrusted('the Deliverable writer is not the verified Listing seller');
    if (!HASH.test(agreementHash ?? '') || deliveryBinding?.jobId !== jobId || deliveryBinding.agreementHash !== agreementHash || !same(deliveryBinding.listing, listingPin(listing))
        || deliveryBinding.payloadHash !== receiptContentHash) return untrusted('the Deliverable binding differs from this Agreement and Listing');
    const read = await authenticated({ logicalAddress, writer, artifactKind: 'Deliverable', deliveryBinding, signedProjection });
    if (read.status !== 'present') return read;
    if (!isDevnetPurchasedReport(read.artifact, { jobId, agreementHash, producer: writer }) || !same(read.artifact.listing, listingPin(listing))
        || read.artifact.settlementId !== settlementId || contentHash(read.artifact) !== receiptContentHash) return contradicted('native Deliverable bytes or bindings differ from this purchase');
    return read;
  }

  async function readDeliveryEvidence({ agreement, listing, seller, signedProjection }) {
    if (!isCanonicalJobId(agreement?.jobId)) return untrusted('canonical JID-1 jobId required');
    const writer = writerFor(listing, seller), logicalAddress = deliveryEvidenceAddress(agreement.jobId);
    if (!writer) return untrusted('the delivery evidence writer is not the verified Listing seller');
    const read = await authenticated({ logicalAddress, writer, artifactKind: 'SettlementEvidence', signedProjection });
    if (read.status !== 'present') return read;
    if (!isNativeDeliveryEvidence(read.artifact, writer, logicalAddress) || read.artifact.jobId !== agreement.jobId) return contradicted('native delivery evidence is not the seller\'s signed evidence for this job');
    return read;
  }

  return Object.freeze({ source: BUYER_CHAIN_READBACK_SOURCE, readCommitment, readDeliverable, readDeliveryEvidence });
}

// Seller answers offer original signed CREATE bytes under this field, keyed by
// logical address. The buyer prefers bytes it has already authenticated.
export const PUBLIC_SIGNED_CREATES = 'publicSignedCreates';
export function signedCreateFor(address, { retained, answer } = {}) {
  const own = object(retained) ? retained[address] : undefined;
  if (own !== undefined) return own;
  const offered = object(answer) && object(answer[PUBLIC_SIGNED_CREATES]) ? answer[PUBLIC_SIGNED_CREATES][address] : undefined;
  return offered;
}
