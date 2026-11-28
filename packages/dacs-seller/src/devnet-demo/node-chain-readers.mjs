// The seller's three chain readers over its finalized wallet session: the commitment receipt reader the wire asks, the session
// admission reads the agent asks and the payment observation the approval policy asks. Each asks `chain()` for the finalized
// session first, reads the chain again on every call, keeps no answer between calls and signs or sends nothing.
import { canonicalize, compositeVerificationAddress, contentHash, encodeAddressSegment } from '@kynesyslabs/dacs';
import { canonicalNodeEndpoint, TESTNET_PROFILE_TP1, TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { currentEnrollment } from '../dacs/authority-reader.mjs';
import { boundedCall } from '../dacs/bounded-call.mjs';
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal } from '../dacs/demos-sr2-adapter.mjs';
import { observedTransferMatches } from '../dacs/native-payment-evidence-consumer.mjs';
import { agreementTerms } from '../dacs/purchase-protocol.mjs';
import { REPLY_LIMIT_CODE, SELLER_PROFILE } from '../dacs/session-admission.mjs';
import { OperationError } from '../operations.mjs';

// Every chain read ends within this many milliseconds, or the caller's shorter `timeoutMs`.
const READ_TIMEOUT_MS = 10_000;
// The revocation surface read ends sooner, leaving the core's 10-second revocation check time to read a revoked marker again.
const SURFACE_TIMEOUT_MS = 7_500;
// The optional storage-proof and finalized-head reads together end within this many milliseconds, or the surface read's remaining time.
const PROOF_READS_TIMEOUT_MS = 1_500;
// Each optional proof or head reply is refused above this many bytes, before it is decoded.
const PROOF_READ_MAX_BYTES = 64 * 1024;
const CHAIN_READER_INPUTS = Object.freeze(['claim', 'chain', 'participantImplementations', 'sessionOf', 'trustedFinality']);
const VET_KIND = 'CompositeVerificationRecord';
const VET_VERDICTS = Object.freeze(['valid', 'invalid', 'indeterminate']);
// Session members that show a payment or settlement was recorded for the job.
const PAYMENT_MEMBERS = Object.freeze(['payment', 'paymentWork', 'nativeEvidenceWork', 'settlementCredit']);
const NOT_ADMITTED = Object.freeze({ disposition: 'not-admitted' });

const withCause = (error, cause) => (cause === undefined ? error : Object.assign(error, { cause }));
const readerInputMissing = (name) => new OperationError('reader_input_missing', `the chain reader was built without ${name}`);
const paymentUnverified = (message, cause) => withCause(new OperationError('payment_unverified', message), cause);
const vetRefused = (message, cause) => withCause(new OperationError('vet_record_unverified', message), cause);
const sameJson = (left, right) => { try { return canonicalize(left) === canonicalize(right); } catch { return false; } };
const revocationAddress = (seller, { listingId, version }) => `dacs1-revoked:${encodeAddressSegment(seller)}:${listingId}:v${version}`;

/**
 * Returns a frozen SR-2 journal the adapter can read and never write: `get`, `records` and `withWalletLock` of a new empty in-memory
 * journal (each read returns a copy), and a `put` that rejects.
 */
export function createReadOnlyDemosSr2Journal() {
  const memory = createInMemoryDemosSr2Journal();
  return Object.freeze({ ...memory, put: async () => { throw new Error('node chain reader cannot write'); } });
}

// The caller's `timeoutMs` when it is a positive integer below `cap`, else `cap`.
const deadlineMs = (timeoutMs, cap) => (Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, cap) : cap);

// Runs `work()` once and settles with its outcome, or rejects with `signal.reason` once `signal` aborts (before the work starts
// too); a late answer resolves nothing.
async function untilAborted(work, signal) {
  signal.throwIfAborted();
  let stop;
  const aborted = new Promise((_resolve, reject) => { stop = () => reject(signal.reason); signal.addEventListener('abort', stop, { once: true }); });
  try { return await Promise.race([work(), aborted]); } finally { signal.removeEventListener('abort', stop); }
}

// Runs `work()` once, waiting at most `timeoutMs` (READ_TIMEOUT_MS at most) and no longer than `signal` stays unaborted.
// An aborted signal rejects with its reason, before the work starts too; a late answer resolves nothing.
async function withinDeadline(work, { signal, timeoutMs } = {}) {
  signal?.throwIfAborted();
  const call = boundedCall(work, { timeoutMs: deadlineMs(timeoutMs, READ_TIMEOUT_MS) });
  return signal ? untilAborted(() => call, signal) : call;
}

// A signal that aborts with a TimeoutError after `ms` milliseconds, and `clear()`, which stops its timer.
function expiringSignal(ms, what) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException(`${what} did not finish within ${ms} ms`, 'TimeoutError')), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

// `value` when its JSON is at most `maxBytes` long (any length without `maxBytes`), else throws `tooLarge()`.
function withinBytes(value, maxBytes, tooLarge) {
  if (maxBytes !== undefined && Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw tooLarge();
  return value;
}
const admissionTooLarge = () => Object.assign(new RangeError('the admission answer exceeds its byte limit'), { code: REPLY_LIMIT_CODE });

/**
 * Builds the seller's chain readers. `claim()` reads the seller's claim; `chain()` returns the finalized session
 * `{ anchor, transport, binding, observeIdentity, clock }` or throws the port's wallet_session_not_finalized or wallet_session_closed;
 * `participantImplementations.entriesFor` is the host's enrollment source and `sessionOf(jobId)` its durable session view. Nothing
 * is read at construction. The optional `trustedFinality` is the operator's pinned finality checkpoint from the seller's
 * configuration; it is forwarded as given and only its presence is read here. Returns frozen `{ sessionAdmission,
 * readCommitmentReceipt, observePayment }`; a reader whose input is missing rejects reader_input_missing naming it. Every read
 * also rejects with `chain()`'s refusal, an aborted signal's reason, or the deadline's timeout error. The Vet reads reject
 * vet_record_unverified, readRevocationMarker revocation_marker_unverified (or the SR-2 adapter's own refusal), and
 * observePayment payment_unverified, each keeping its cause. readRevocationSurfaces ends within 7,500 ms and answers a failed
 * marker read as one unavailable surface (node_endpoint_refused for a bound endpoint that is not a canonical node root). With
 * `trustedFinality`, an authenticated marker's native address is then asked for its storage proof and the node for its finalized
 * head, through the bound transport; their replies change no surface. Throws TypeError for an input other than these five.
 */
export function createNodeChainReaders(inputs) {
  const extra = Object.keys(inputs ?? {}).filter((name) => !CHAIN_READER_INPUTS.includes(name));
  if (extra.length) throw new TypeError(`unknown createNodeChainReaders input: ${extra.join(', ')}`);
  const { claim, chain, participantImplementations, sessionOf, trustedFinality } = inputs;
  const adapters = new WeakMap();
  const bound = () => {
    if (typeof chain !== 'function') throw readerInputMissing('chain');
    return chain();
  };

  // The wire's commitment receipt reader: the bound anchor's fresh check of the anchored record's receipt.
  async function readCommitmentReceipt(anchored) {
    const { anchor } = bound();
    const verdict = await anchor.verifyReceipt({ logicalAddress: anchored.anchorReceipt.logicalAddress, artifact: anchored.record,
      artifactKind: 'FinalityCommitmentRecord', receipt: anchored.anchorReceipt, fresh: true });
    return VET_VERDICTS.includes(verdict) ? verdict : 'indeterminate';
  }
  Object.defineProperty(readCommitmentReceipt, 'chainIdentity', { value: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, enumerable: true });

  // The admission answer for one query, or NOT_ADMITTED: the buyer's one current enrollment on the bound profile and the TP-1 tuple.
  async function admitted(query, binding, signal) {
    if (query?.seller !== claim() || !sameJson(query.profile, SELLER_PROFILE)) return NOT_ADMITTED;
    const entry = await currentEnrollment(participantImplementations, query.buyer, { sessionId: query.jobId, signal });
    if (entry === null || !sameJson(entry.profile, binding.profile) || !sameJson(entry.modules, TESTNET_PROFILE_TP1.tuple)) return NOT_ADMITTED;
    const participant = (role, party) => ({ role, claim: party, standardRevision: SELLER_PROFILE.standardRevision, documentVersions: { ...SELLER_PROFILE.documentVersions } });
    return { disposition: 'admitted', jobId: query.jobId, buyer: query.buyer, buyerBundleHash: query.buyerBundleHash, listingPin: structuredClone(query.listingPin),
      participants: [participant('buyer', query.buyer), participant('seller', query.seller)] };
  }

  // The Vet reference's checks before any read: its locator is the job's composite address for `party`, and its verifier.
  function vetScope({ jobId, party, ref }) {
    const locator = compositeVerificationAddress(jobId, party);
    if (ref?.anchor?.locator !== locator) throw vetRefused('the Vet reference is not at the job\'s composite address');
    return locator;
  }
  const verifierMatches = (ref, record) => ref.signer === undefined || record?.signature?.signer === ref.signer;

  // The seller-owned Vet record and receipt the bound anchor reads back now, checked against the reference; rejects otherwise.
  async function retainedVet(anchor, query) {
    const locator = vetScope(query);
    const read = await anchor.readRetained({ logicalAddress: locator, artifactKind: VET_KIND, fresh: true });
    if (read?.status !== 'present') throw vetRefused(`the Vet record does not read back (${read?.status ?? 'no answer'})`);
    if (contentHash(read.artifact) !== query.ref.contentHash || !verifierMatches(query.ref, read.artifact)) throw vetRefused('the Vet record is not the one its reference names');
    return { record: read.artifact, receipt: read.receipt, locator };
  }

  // The read-only SR-2 adapter over the bound transport, built once for it; throws when its endpoint is not a canonical node root.
  function markerAdapter({ transport, binding, observeIdentity, clock }) {
    if (adapters.has(transport)) return adapters.get(transport);
    const rpcUrl = canonicalNodeEndpoint(transport.pins.endpoint, { chainIdentity: binding.profile.chainIdentity });
    if (rpcUrl === null) throw new OperationError('node_endpoint_refused', 'the bound node endpoint is not a canonical node root');
    const adapter = createDemosSr2Adapter({ rpcUrl, journal: createReadOnlyDemosSr2Journal(), sourceCapability: transport, binding, observeIdentity,
      ownWriter: claim(), now: () => clock.now() });
    adapters.set(transport, adapter);
    return adapter;
  }
  // The SR-2 adapter's authenticated present read of the marker, with its `artifact` and its `demosEvidence.nativeAddress`.
  async function readMarker(session, logicalAddress) {
    const read = await markerAdapter(session).read(logicalAddress, { expectedWriter: claim() });
    if (read?.status !== 'present') throw new OperationError('revocation_marker_unverified', 'the revocation marker does not read back');
    return read;
  }
  const failureReason = (error) => [error?.observation, error?.code].find((reason) => typeof reason === 'string' && reason !== '') ?? 'marker-read-failed';

  // Asks the bound transport for the storage proof of `storageAddress`, then for the finalized head, each reply at most
  // PROOF_READ_MAX_BYTES and both within PROOF_READS_TIMEOUT_MS or until `ends` aborts. A failed read ends the pair. Nothing read
  // is kept or returned: no reply can change a revocation surface.
  async function readProofAndHead(transport, storageAddress, ends) {
    const pair = expiringSignal(PROOF_READS_TIMEOUT_MS, 'the storage proof reads');
    const signal = AbortSignal.any([ends, pair.signal]);
    const nodeRead = (call) => transport.readRpc('/', { method: 'nodeCall', params: [call] }, { signal, maxBytes: PROOF_READ_MAX_BYTES });
    try {
      await untilAborted(async () => {
        await nodeRead({ message: 'getStorageProof', data: { storageAddresses: [storageAddress] } });
        await nodeRead({ message: 'getFinalizedHead' });
      }, signal);
    } catch {
      // The replies are not verified here, so a failed, refused or late read is the same as a discarded answer.
    } finally { pair.clear(); }
  }

  // The one revocation surface for `listingPin`: revoked when the SR-2 adapter authenticates the seller's marker, else unavailable.
  // Rejects with the reason of `ends` when it aborts during the marker read; the optional proof reads use what is left of it.
  async function revocationSurfaces({ listingPin }, session, ends) {
    const seller = claim(), logicalAddress = revocationAddress(seller, listingPin);
    let read;
    try { read = await untilAborted(() => readMarker(session, logicalAddress), ends); } catch (error) {
      if (ends.aborted && error === ends.reason) throw error;
      return [{ kind: 'catalog', status: 'active', readStatus: 'unavailable', readFailureReason: failureReason(error) }];
    }
    if (trustedFinality !== undefined) await readProofAndHead(session.transport, read.demosEvidence.nativeAddress, ends);
    return [{ kind: 'catalog', status: 'revoked', readStatus: 'ok', catalogObservedAt: session.clock.now(), binding: { sellerPrimaryClaim: seller, listingId: listingPin.listingId,
      listingVersion: listingPin.version, listingContentHash: listingPin.contentHash, logicalAddress, markerAnchor: { kind: 'storage-program', locator: logicalAddress },
      markerContentHash: contentHash(read.artifact) } }];
  }

  // One admission method: the session first, then its own input check, then the read within the caller's deadline and byte limit.
  const admissionMethod = (requires, read) => async (query, { signal, timeoutMs, maxBytes } = {}) => {
    const session = bound();
    requires?.();
    return withinBytes(await withinDeadline(() => read(query, session, signal), { signal, timeoutMs }), maxBytes, admissionTooLarge);
  };
  const requireEnrollment = () => { if (typeof participantImplementations?.entriesFor !== 'function') throw readerInputMissing('participantImplementations'); };
  const sessionAdmission = Object.freeze({
    admit: admissionMethod(requireEnrollment, (query, { binding }, signal) => admitted(query, binding, signal)),
    resolveVetRecord: admissionMethod(null, async (query, { anchor }) => (await retainedVet(anchor, query)).record),
    readVetAnchorReceipt: admissionMethod(null, async (query, { anchor }) => {
      const { receipt, locator } = await retainedVet(anchor, query);
      if (receipt?.logicalAddress !== locator || receipt.contentHash !== query.ref.contentHash || receipt.state !== 'finalized') throw vetRefused('the Vet record has no finalized receipt for its reference');
      return receipt;
    }),
    verifyVetAnchorReceipt: admissionMethod(null, async ({ jobId, party, ref, record, receipt }, { anchor }) => {
      const logicalAddress = vetScope({ jobId, party, ref });
      if (contentHash(record) !== ref.contentHash || !verifierMatches(ref, record)) return 'invalid';
      const verdict = await anchor.verifyReceipt({ logicalAddress, artifact: record, artifactKind: VET_KIND, receipt, writer: claim(),
        verifier: ref.signer ?? record.signature.signer, fresh: true });
      return VET_VERDICTS.includes(verdict) ? verdict : 'indeterminate';
    }),
    readRevocationSurfaces: async (query, { signal, timeoutMs, maxBytes } = {}) => {
      const session = bound();
      signal?.throwIfAborted();
      const surface = expiringSignal(deadlineMs(timeoutMs, SURFACE_TIMEOUT_MS), 'the revocation surface read');
      try {
        const ends = signal ? AbortSignal.any([signal, surface.signal]) : surface.signal;
        return withinBytes(await revocationSurfaces(query, session, ends), maxBytes, admissionTooLarge);
      } finally { surface.clear(); }
    },
    readRevocationMarker: admissionMethod(null, async (markerAnchor, session) => {
      if (typeof markerAnchor?.locator !== 'string' || !markerAnchor.locator.startsWith(`dacs1-revoked:${encodeAddressSegment(claim())}:`)) {
        throw new OperationError('revocation_marker_unverified', 'the marker anchor is not one of this seller\'s revocation addresses');
      }
      return (await readMarker(session, markerAnchor.locator)).artifact;
    }),
  });

  // The payment reading for `query` from the retained session and a fresh observation of its payment transfer.
  async function paymentReading(query, { transport, binding, observeIdentity, clock }, signal) {
    let session;
    try { session = sessionOf(query.jobId); } catch (error) { throw paymentUnverified('the seller session cannot be read', error); }
    if (!session?.agreement || session.agreementHash !== query.agreementHash || contentHash(session.agreement) !== query.agreementHash || !Number.isSafeInteger(query.observedAt)) {
      throw paymentUnverified('the retained session does not hold the queried Agreement');
    }
    const reading = (disposition, paymentTxRef) => ({ disposition, jobId: query.jobId, agreementHash: query.agreementHash, observedAt: Math.max(query.observedAt, clock.now()), paymentTxRef });
    const work = session.nativeEvidenceWork, retained = work?.intake?.settlementIdentity;
    if (retained === undefined || retained === null) {
      if (PAYMENT_MEMBERS.some((name) => session[name] !== undefined && session[name] !== null)) throw paymentUnverified('a payment is recorded without its payment reference');
      if (session.settlementBound !== false) throw paymentUnverified('a settlement is bound to the job without its payment reference');
      if (await observeIdentity({ signal, timeoutMs: READ_TIMEOUT_MS }) !== binding.profile.chainIdentity) throw paymentUnverified('the connection does not read as the bound chain');
      return reading('absent', null);
    }
    const txHash = work.txHash, committedAt = session.commitment?.committedAt;
    if (typeof txHash !== 'string' || typeof retained.txHash !== 'string' || retained.txHash.toLowerCase() !== txHash) throw paymentUnverified('the retained payment reference does not name its transfer');
    if (!Number.isSafeInteger(committedAt)) throw paymentUnverified('the retained commitment has no time');
    const observed = await transport.chainReader().observeTransfer(txHash, { signal });
    if (observed?.status !== 'included' || observed.blockNumber !== retained.blockNumber
      || !observedTransferMatches(observed, { txHash, terms: agreementTerms(session.agreement), committedAt })) {
      throw paymentUnverified(`the payment transfer is not the Agreement's executed payment (${observed?.status ?? 'no answer'})`);
    }
    return reading('verified', { kind: 'demos', txHash, blockNumber: retained.blockNumber });
  }

  // The approval policy's payment observer: `verified` only for a transfer observed on this call, `absent` only when the session
  // records no payment, its view says no settlement is bound to the job, and the connection reads as the bound chain now; anything else rejects payment_unverified, keeping its cause.
  async function observePayment(query, { timeoutMs, maxBytes, signal } = {}) {
    const session = bound();
    if (typeof sessionOf !== 'function') throw readerInputMissing('sessionOf');
    let answer;
    try { answer = await withinDeadline(() => paymentReading(query, session, signal), { signal, timeoutMs }); } catch (error) {
      if (signal?.aborted && error === signal.reason) throw error;
      throw error?.code === 'payment_unverified' ? error : paymentUnverified('the payment cannot be observed', error);
    }
    return withinBytes(answer, maxBytes, () => new TypeError('the payment reading exceeds its byte limit'));
  }

  return Object.freeze({ sessionAdmission, readCommitmentReceipt, observePayment });
}
