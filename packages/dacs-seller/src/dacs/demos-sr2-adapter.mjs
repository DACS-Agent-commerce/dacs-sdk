// Offline SR-2 fixture readback authenticates exact CREATE authorization,
// confirmed inclusion and native contents. Literal marked loopback replies
// establish simulated-fixture evidence only, never real consensus or finality:
// their receipts carry the DEMOS_SR2_FIXTURE_RECEIPT labels, not Demos ones,
// and the demosEvidence a fixture read returns carries the same state and
// finality labels, which the core receipt converter refuses.
// The adapter owns no key and never broadcasts.
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  attestationBundleHash, canonicalize, contentHash, identityBundleHash,
  isAnchorReceipt, logicalToStorageProgramName, sha256Hex,
  assertDemosWriteEvidence, decodeDemosAnchorReceiptProof,
  demosSignedTransactionProofHash, demosWriteEvidenceBindsReceiptContent,
  demosWriteEvidenceToAnchorReceipt,
} from '@kynesyslabs/dacs';
import { canonicalNodeEndpoint, TP1_APPROVED_IDENTITY_RECORD_DIGESTS, TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES } from '@kynesyslabs/dacs/wire';
import { fetchBoundedJson } from '../util/http.mjs';
import { addressForClaim } from './demos-claims.mjs';
import { assertNoCallerSignatureDomain, signatureDomainFromNetworkInfo } from './signature-domain.mjs';
import { liveExpectedIdentity, sameSharedTuple } from './sr2-live-identity.mjs';
import { verifyTransactionSignature } from './transaction-signature.mjs';
import { deriveStorageAddress } from './wallet-transactions.mjs';

// Import the pure signed-to-executed projection from the core public root;
// the substrate barrel eagerly loads an optional demosdk peer.
import { demosTransactionContentMatches } from '@kynesyslabs/dacs';
import { isDevnetAgreementTransport } from './devnet-source.mjs';

export const DEMOS_SR2_EVIDENCE_MODE = 'simulated-fixture';
/** Labels on every receipt a marked loopback fixture issues: simulated inclusion only, never Demos BFT finality. */
export const DEMOS_SR2_FIXTURE_RECEIPT = Object.freeze({
  substrate: 'demos-sr2-simulated-fixture', finalityProfile: 'simulated-fixture-inclusion-only', state: 'included', evidenceKind: 'demos-sr2-simulated-fixture-proof-v1',
});
const DEMOS_FINALITY_RECEIPT = Object.freeze({
  substrate: 'demos', finalityProfile: 'demos-bft-confirmed-native-read', state: 'finalized', evidenceKind: 'demos-bft-write-proof-v1',
});
const labelReceipt = (receipt, labels) => ({ ...receipt, substrate: labels.substrate, finalityProfile: labels.finalityProfile,
  state: labels.state, evidence: { kind: labels.evidenceKind, value: receipt.evidence.value } });
const hasReceiptLabels = (receipt, labels) => receipt.substrate === labels.substrate && receipt.finalityProfile === labels.finalityProfile
  && receipt.state === labels.state && receipt.evidence.kind === labels.evidenceKind;
export const DEMOS_SR2_FIXTURE_CHAIN_IDENTITY = sha256Hex('dacs-chatgpt-plugin/demos-sr2-sdk-wire-fixture/v1');
/** Byte cap on one node reply; callers also bound their own inputs by it. */
export const DEMOS_SR2_REPLY_BYTES = 1024 * 1024;
const NATIVE_ADDRESS = /^stor-[0-9a-f]{40}$/;
/** Cap on same-name programs read from the name index, whoever owns them. */
const MAX_FOREIGN_NATIVE_READS = 32;
const HASH = /^[0-9a-f]{64}$/;
const LITERAL_LOOPBACK = new Set(['127.0.0.1', '[::1]']);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => structuredClone(v);
const exactHash = (v) => sha256Hex(canonicalize(v));
// Payloads retain every member; signed artifacts use their normative scope.
function artifactContentHash(artifact, kind) {
  if (kind === undefined || kind === 'Deliverable') return exactHash(artifact);
  if (kind === 'IdentityBundle') return identityBundleHash(artifact);
  if (['AttestationBundle', 'FaultAttestationBundle', 'EvidenceBoundFaultAttestationBundle'].includes(kind)) return attestationBundleHash(artifact);
  return contentHash(artifact);
}
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const wireInteger = (v) => integer(v) ? v : typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) && integer(Number(v)) ? Number(v) : null;

// Node2's confirmed storageProgram projection can omit the two source-binding
// properties that remain present in the original signed CREATE. Restore that
// exact pair only in a fresh comparison copy, and only when an authentic
// projected/retained authorization binds the expected `network` (the source
// pin's, or the passive identity record's) and chain. Fixture reads pass no
// network. Raw content is never a source of missing authorization and no input is mutated.
function sourceBoundStorageComparison({ network, expectedIdentity, authenticContent, executedContent, authenticated }) {
  if (!network || !authenticated || !object(authenticContent) || !object(executedContent)) return executedContent;
  const authenticBinding = typeof authenticContent.network === 'string' && authenticContent.network.length > 0
    && authenticContent.network === network
    && typeof authenticContent.chainIdentity === 'string' && authenticContent.chainIdentity.length > 0
    && authenticContent.chainIdentity === expectedIdentity;
  if (!authenticBinding) return executedContent;
  const hasNetwork = Object.hasOwn(executedContent, 'network');
  const hasChainIdentity = Object.hasOwn(executedContent, 'chainIdentity');
  return !hasNetwork && !hasChainIdentity
    ? { ...executedContent, network: authenticContent.network, chainIdentity: authenticContent.chainIdentity }
    : executedContent;
}

// Node2's public storage object can omit both creation-provenance properties.
// The omission is comparison-only: an independently retained/projected signed
// CREATE still supplies the hash, and the transaction plus containing block
// are authenticated below. Rich public projections remain byte-for-byte
// strict, while partial or present-invalid projections are never upgraded.
function creationProvenanceMatches(native, txHash, allowPairedAbsence) {
  const hasCreatedByTx = Object.hasOwn(native, 'createdByTx');
  const hasInteractionTxs = Object.hasOwn(native, 'interactionTxs');
  if (!hasCreatedByTx && !hasInteractionTxs) return allowPairedAbsence;
  return hasCreatedByTx && hasInteractionTxs
    && native.createdByTx === txHash
    && Array.isArray(native.interactionTxs)
    && native.interactionTxs.includes(txHash);
}

export class DemosSr2Error extends Error {
  constructor(code, message, options) { super(message, options); this.code = code; if (options?.status !== undefined) this.status = options.status; }
}
const reject = (code, message, options) => { throw new DemosSr2Error(code, message, options); };

// The chain identity of a passive adapter: `identityRecord.chainIdentity`, once the record is one the SDK approved (its canonical
// digest is listed) and names no simulated fixture chain. A caller's record never extends the approved list.
function passiveExpectedIdentity(identityRecord) {
  if (TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES.includes(identityRecord?.chainIdentity)) reject('tp1_identity_fixture', 'the simulated fixture chain is not a live chain identity');
  let digest = null;
  try { digest = exactHash(identityRecord); } catch { /* an uncanonical record is not approved */ }
  if (!TP1_APPROVED_IDENTITY_RECORD_DIGESTS.includes(digest)) reject('tp1_identity_unapproved', 'the identity record is not an SDK-approved record');
  return identityRecord.chainIdentity;
}

// Offline journal only. Retaining the same journal across adapter instances,
// or restoring its serializable snapshot, preserves issued handoffs. A real
// deployment requires an atomic durable wallet journal, including ALL other
// wallet operations. This helper deliberately makes no durability claim.
export function createInMemoryDemosSr2Journal(initial = []) {
  const records = new Map(initial.map((r) => [r.planId, clone(r)]));
  const tails = new Map();
  return {
    get: (id) => records.has(id) ? clone(records.get(id)) : null,
    put: (r) => records.set(r.planId, clone(r)),
    records: () => [...records.values()].map(clone),
    async withWalletLock(key, work) {
      const previous = tails.get(key) ?? Promise.resolve();
      let unlock;
      const next = new Promise((resolve) => { unlock = resolve; });
      tails.set(key, next);
      await previous;
      try { return await work(); } finally {
        unlock();
        if (tails.get(key) === next) tails.delete(key);
      }
    },
  };
}

/** Transaction reference for an authenticated receipt: its native address and CREATE hash. */
export function demosSr2TxRef(receipt) {
  return { kind: 'storage-program', address: receipt.nativeAddress, writeTxHash: receipt.transactionRef.value };
}

/**
 * The SR-2 readback over one node. The transaction signature it accepts follows the
 * node's own `getNetworkInfo` answer, read on each authentication: the bare hash while
 * the signature-domain fork is inactive, `demos-tx:v1:<chain id>:<hash>` once it is
 * active. An answer that cannot be read is `indeterminate` and authenticates nothing.
 *
 * With a `sourceCapability` the adapter is live. It then takes its chain identity from `binding`, the `bindTp1Profile` binding the
 * host holds, and needs `observeIdentity({ signal, timeoutMs })`, the host's connection decision on the chain identity: it resolves
 * the identity the shared reader observes now, `undefined` for a connection it cannot authenticate, and rejects with its own error
 * when it cannot read. An observation is only compared with `binding`; it never authorizes a record. A record whose writer is
 * `ownWriter` must carry the source's own binding exactly; a record of any other writer needs the shared tuple only. Without
 * `ownWriter` every record is held to the exact binding.
 *
 * With an `identityRecord` and no `sourceCapability` the adapter is passive: it reads a published record over a node it neither
 * writes to nor recovers through. `identityRecord` must be an SDK-approved TP-1 identity record, `rpcUrl` a canonical root that
 * `canonicalNodeEndpoint` admits under the record's chain identity (https, or plain http only on the approved TP-1 testnet identity;
 * any other root is refused `offline-only` before a read), and `observeIdentity` as above. Its reads refuse an answer that carries
 * the simulation marker, an authenticated result carries `finality: 'not-established'`, and its receipts keep the Demos labels.
 * Throws TypeError for a `signatureChainId` option, or for a live or passive adapter without `observeIdentity` or a live one without
 * `binding`, and an error with code `tp1_identity_fixture` or `invalid-chain` when the source's pin is a fixture chain or disagrees
 * with `binding`. A passive adapter refuses `tp1_identity_fixture`, `tp1_identity_unapproved` or `offline-only` for its record or endpoint.
 */
export function createDemosSr2Adapter({ rpcUrl, journal, fetchImpl = globalThis.fetch, timeoutMs = 10000, now = () => Date.now(), sourceCapability = null, binding: boundProfile, observeIdentity, ownWriter, signatureChainId, identityRecord }) {
  assertNoCallerSignatureDomain({ signatureChainId });
  const passive = sourceCapability === null && identityRecord !== undefined;
  if(sourceCapability !== null && (!isDevnetAgreementTransport(sourceCapability)||typeof sourceCapability.observeBinding!=='function')) reject('source-held','an opaque independently supplied Agreement transport is required');
  if((sourceCapability !== null || passive) && typeof observeIdentity !== 'function') throw new TypeError('a live or passive adapter needs observeIdentity');
  const passiveIdentity = passive ? passiveExpectedIdentity(identityRecord) : null;
  if (passive && canonicalNodeEndpoint(rpcUrl, { chainIdentity: passiveIdentity }) === null) reject('offline-only', 'passive SR-2 requires a canonical approved endpoint');
  const endpoint = new URL(rpcUrl);
  if (!passive && (sourceCapability ? rpcUrl !== sourceCapability.pins.endpoint : (endpoint.protocol !== 'http:' || !LITERAL_LOOPBACK.has(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/'))) {
    reject('offline-only', 'Demos SR-2 requires a literal HTTP loopback root endpoint');
  }
  if (!journal || ['records'].some((k) => typeof journal[k] !== 'function')) reject('journal-required', 'an explicit readback journal is required');
  const base = endpoint.origin;
  // Live and passive reads hold chain evidence; only fixture reads are simulated.
  const live = sourceCapability !== null || passive;
  const expectedIdentity=sourceCapability ? liveExpectedIdentity({ binding: boundProfile, sourceCapability }) : passive ? passiveIdentity : DEMOS_SR2_FIXTURE_CHAIN_IDENTITY;
  const expectedNetwork = sourceCapability ? sourceCapability.pins.network : passive ? identityRecord.network : null;
  const mode=sourceCapability ? 'explicit-pinned-transport-single-node' : passive ? 'passive-pinned-record-single-node' : DEMOS_SR2_EVIDENCE_MODE;
  const receiptLabels = live ? DEMOS_FINALITY_RECEIPT : DEMOS_SR2_FIXTURE_RECEIPT;
  const scope = canonicalize([base, expectedIdentity,...(sourceCapability?[sourceCapability.transportBinding.bindingId]:[])]);
  const ownRecords = async () => (await journal.records()).filter((r) => r.scope === scope);
  const retained = async (logicalAddress, writer) => (await ownRecords()).find((r) => r.logicalAddress === logicalAddress && r.writer === writer);
  // One aggregate deadline per resolution: its signal and the moment it ends, which every read inside it shares. A caller's
  // aborted `signal` refuses with its reason before any read, and an abort during the resolution ends it with that reason.
  const readBudget = new AsyncLocalStorage();
  async function boundedRead(work, signal) {
    if (readBudget.getStore()) return work();
    signal?.throwIfAborted();
    const controller = new AbortController();
    const cause = new DOMException('SR-2 aggregate read deadline exceeded', 'TimeoutError');
    let timer, onAbort;
    const stopped = new Promise((_, fail) => {
      timer = setTimeout(() => { controller.abort(cause); fail(new DemosSr2Error('indeterminate', cause.message, { cause })); }, timeoutMs);
      onAbort = () => { controller.abort(signal.reason); fail(signal.reason); };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    const budget = { signal: controller.signal, endsAt: performance.now() + timeoutMs };
    try { return await readBudget.run(budget, () => Promise.race([work(), stopped])); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); controller.abort(); }
  }
  // The whole milliseconds left of the current resolution's deadline (at least 1), or the full deadline outside one.
  const remainingMs = () => {
    const budget = readBudget.getStore();
    return budget ? Math.min(timeoutMs, Math.max(1, Math.ceil(budget.endsAt - performance.now()))) : timeoutMs;
  };

  async function call(path, body) {
    try {
      const signal = readBudget.getStore()?.signal; signal?.throwIfAborted();
      if(sourceCapability) return await sourceCapability.readRpc(path,body,{signal,maxBytes:DEMOS_SR2_REPLY_BYTES,timeoutMs:remainingMs()});
      return await fetchBoundedJson(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST', body, timeoutMs, maxBytes: DEMOS_SR2_REPLY_BYTES, expectedOrigin: base,
        fetchImpl: async (url, options) => {
          const signal = readBudget.getStore()?.signal; signal?.throwIfAborted();
          const response = await fetchImpl(url, { ...options, signal: signal ? AbortSignal.any([signal, options.signal]) : options.signal });
          signal?.throwIfAborted();
          // Fixture replies must carry the simulation marker; a passive read refuses one, so fixture evidence never reads as live.
          if (passive ? response.headers.has('x-dacs-simulation') : response.headers.get('x-dacs-simulation') !== 'fixture') {
            await response.body?.cancel().catch(() => {});
            reject('indeterminate', passive ? 'a passive SR-2 response must not carry the simulation marker' : 'every SR-2 response must carry the simulation marker');
          }
          return response;
        },
      });
    } catch (error) {
      if (error instanceof DemosSr2Error) throw error;
      reject('indeterminate', `SR-2 observation unavailable: ${error.message ?? error.kind ?? 'transport'}`, { cause: error, status: error.status });
    }
  }
  async function nodeCall(message, data) {
    const answer = await call('/', { method: 'nodeCall', params: [{ message, data }] });
    if (!object(answer) || answer.result !== 200 || !Object.hasOwn(answer, 'response')) reject('indeterminate', 'malformed nodeCall result');
    return answer.response;
  }
  async function signatureDomain() {
    const info = await nodeCall('getNetworkInfo');
    try { return signatureDomainFromNetworkInfo(info); }
    catch (cause) { reject('indeterminate', cause.message, { cause }); }
  }
  // The host's observation of the chain identity, which must be the one `binding` names. It is asked once for each resolution and is a
  // comparison only: a record still has to authenticate by itself.
  async function observedIdentityMatches(signal) {
    const budget = readBudget.getStore();
    if (budget?.identityObserved) return;
    let observed;
    try { observed = await observeIdentity({ signal, timeoutMs: remainingMs() }); }
    catch (error) { reject('indeterminate', `chain identity observation unavailable: ${error?.message ?? 'transport'}`, { cause: error, status: error?.status }); }
    if (observed !== expectedIdentity) reject('invalid-chain', 'the observed chain identity is not the bound one');
    if (budget) budget.identityObserved = true;
  }
  async function chainIdentity() {
    const signal = readBudget.getStore()?.signal; signal?.throwIfAborted();
    if(sourceCapability){
      let binding;
      try{binding=await sourceCapability.observeBinding({signal,timeoutMs:remainingMs()});}
      catch(error){reject('indeterminate',`source-bound chain identity observation unavailable: ${error?.message??'transport'}`,{cause:error,status:error?.status});}
      const keys=['bindingId','bindingVersion','chainIdentity','connectionId','endpoint','expiresAt','network','observedAt','pinVersion','source','transportAuthority'];
      if(!object(binding)||JSON.stringify(Object.keys(binding).sort())!==JSON.stringify(keys)
        ||typeof binding.connectionId!=='string'||!binding.connectionId||!object(binding.source)||!integer(binding.observedAt)||!integer(binding.expiresAt)||binding.expiresAt<=binding.observedAt) reject('indeterminate','source-bound chain identity observation is malformed');
      const declaration=sourceCapability.transportBinding;
      if(['bindingVersion','bindingId','network','chainIdentity','pinVersion','endpoint','transportAuthority'].some((key)=>binding[key]!==declaration[key])
        ||binding.chainIdentity!==expectedIdentity) reject('invalid-chain','source-bound chain identity differs');
      await observedIdentityMatches(signal);
      return binding.chainIdentity;
    }
    if (passive) {
      await observedIdentityMatches(signal);
      return expectedIdentity;
    }
    const genesis = await nodeCall('getBlockByNumber', { blockNumber: 0 });
    if (genesis?.number !== 0 || genesis.status !== 'confirmed' || genesis.hash !== expectedIdentity) reject('invalid-chain', 'source-bound chain identity differs');
    return genesis.hash;
  }
  async function nativeRead(address) {
    if (!NATIVE_ADDRESS.test(address)) reject('invalid', 'malformed native address');
    let value;try{value=await call(`/storage-program/${address}`);}catch(error){if(error?.status===404)error.observation='native-address-miss';throw error;}
    if (!object(value) || value.success !== true || value.storageAddress !== address
      || typeof value.owner !== 'string' || typeof value.programName !== 'string') reject('indeterminate', 'native readback lacks an exact address, owner, data or metadata');
    return value;
  }

  // The programs at these addresses that belong to the writer, each read and
  // authenticated (owner, program name, payload, logical address). A program of
  // another owner is skipped after its owner check and its payload is not read.
  async function readOwnedPrograms(addresses, owner, programName, logicalAddress) {
    const owned = [];
    for (const address of addresses) {
      const native = await nativeRead(address);
      if (native.programName !== programName) reject('invalid', 'name index and native program name differ; only SDK-derived program names are supported');
      if (native.owner !== owner) continue;
      if (!object(native.data) || !object(native.metadata)) reject('invalid', 'owned native record lacks DACS payload or metadata');
      if (native.metadata.logicalAddress !== logicalAddress) reject('invalid', 'native metadata names another logical address');
      owned.push(native);
    }
    return owned;
  }

  // The same for the supplied and retained addresses, where a 404 is not
  // fatal yet: it is returned as `miss`, to be thrown if no program is found
  // at all, so an unreadable name index never reads as an absent program.
  async function readKnownPrograms(addresses, owner, programName, logicalAddress) {
    const owned = [];
    let miss = null;
    for (const address of addresses) {
      try { owned.push(...await readOwnedPrograms([address], owner, programName, logicalAddress)); } catch (error) {
        if (error?.observation !== 'native-address-miss') throw error;
        miss ??= error;
      }
    }
    return { owned, miss };
  }

  // The same-name addresses from the bounded name-index pages. Paging stops
  // once there are more than MAX_FOREIGN_NATIVE_READS: they are not read.
  async function searchNameIndex(programName) {
    const candidates = new Set();
    for (let page = 0; page < 8; page += 1) {
      const rows = await nodeCall('searchStoragePrograms', { query: programName, options: { exactMatch: true, limit: 50, offset: page * 50 } });
      if (!Array.isArray(rows) || rows.length > 50) reject('indeterminate', 'malformed name-index page');
      for (const row of rows) {
        if (!object(row) || !NATIVE_ADDRESS.test(row.storageAddress) || typeof row.programName !== 'string') reject('indeterminate', 'malformed name-index candidate');
        if (row.programName === programName) candidates.add(row.storageAddress);
      }
      if (candidates.size > MAX_FOREIGN_NATIVE_READS || rows.length < 50) return [...candidates];
    }
    reject('indeterminate', 'name index exceeds the bounded pagination limit');
  }

  // Do not guess a nonce-derived physical address for another writer. The
  // supplied and retained native addresses are authenticated first (owner,
  // name, logical address). The other same-name programs are read, for the
  // owner check that finds a second program of this writer, only while there
  // are at most MAX_FOREIGN_NATIVE_READS of them. Past that cap a program that
  // authenticated is still the answer, and without one the read is
  // indeterminate: foreign programs cannot exhaust the readback budget.
  async function resolve(logicalAddress, expectedWriter, nativeAddress) {
    const owner = addressForClaim(expectedWriter);
    const programName = logicalToStorageProgramName(logicalAddress);
    await chainIdentity();
    if (nativeAddress !== undefined && !NATIVE_ADDRESS.test(nativeAddress)) reject('invalid', 'malformed supplied native address');
    const saved = await retained(logicalAddress, expectedWriter);
    const known = [...new Set([nativeAddress, saved?.nativeAddress].filter((address) => address !== undefined))];
    const indexed = (await searchNameIndex(programName)).filter((address) => !known.includes(address));
    const found = await readKnownPrograms(known, owner, programName, logicalAddress);
    let owned = found.owned;
    if (indexed.length <= MAX_FOREIGN_NATIVE_READS) owned = [...owned, ...await readOwnedPrograms(indexed, owner, programName, logicalAddress)];
    else if (owned.length === 0) reject('indeterminate', 'native candidate budget exceeded');
    if (owned.length === 0 && found.miss) throw found.miss;
    if (owned.length > 1) reject('indeterminate', 'multiple programs belong to this logical address and writer');
    if (owned.length === 0 && saved) reject('indeterminate', 'retained handoff has no authenticated native readback');
    return owned[0] ?? null;
  }

  // The seller's own records carry the source's binding exactly. Another writer's carry its own endpoint, so they need the shared tuple only.
  const bindsSourcePin = (recorded, writer) => ownWriter === undefined || writer === ownWriter
    ? canonicalize(recorded) === canonicalize(sourceCapability.transportBinding)
    : sameSharedTuple(recorded, sourceCapability.transportBinding);

  async function authenticate(logicalAddress, expectedWriter, native, txHash, saved = null, signedProjection) {
    const identity = await chainIdentity();
    if (!HASH.test(txHash)) reject('invalid', 'transaction hash must be SHA-256 hex');
    // Preserve the historical fail-closed ordering for a rich projection: a
    // changed receipt pointer must be rejected before attempting to fetch it.
    // The paired-absent case proceeds only because its authority is supplied
    // independently and authenticated below.
    if ((Object.hasOwn(native, 'createdByTx') || Object.hasOwn(native, 'interactionTxs'))
      && !creationProvenanceMatches(native, txHash, false)) {
      reject('invalid', 'native creation provenance names another transaction');
    }
    const tx = await nodeCall('getTxByHash', { hash: txHash });
    if (!object(tx) || tx.status !== 'confirmed' || !integer(tx.blockNumber) || tx.blockNumber < 1) reject('indeterminate', 'transaction inclusion is not established');
    const c = tx.content;
    const op = c?.data?.[1];
    const owner = addressForClaim(expectedWriter);
    const domain = await signatureDomain();
    const embedded = saved?.authorizationProfile === 'embedded-storage-anchor-create';
    // Public evidence is data, never a retained wallet authorization. A caller
    // may supply the original signed CREATE when RPC normalizes executed fields;
    // it must pass the same signature, projection and fresh native checks.
    const projected = signedProjection !== undefined;
    const signed = projected ? signedProjection : embedded ? saved.authorizedTransaction : { hash: tx.hash, content: c, signature: tx.signature };
    if (!object(signed) || !object(signed.content) || tx.hash !== txHash || !object(c) || signed.hash !== txHash
      || sha256Hex(JSON.stringify(signed.content)) !== txHash || signed.signature?.type !== 'ed25519' || !object(tx.signature) || canonicalize(tx.signature) !== canonicalize(signed.signature)
      || signed.content.from !== owner || c.from !== owner || c.from_ed25519_address !== owner
      || !verifyTransactionSignature({ address: owner, hash: txHash, signature: tx.signature.data, domain, blockNumber: tx.blockNumber })) reject('invalid', 'transaction lacks the exact writer authorization');
    if (!creationProvenanceMatches(native, txHash, live && (embedded || projected))) {
      reject('invalid', 'native creation provenance does not bind the authenticated transaction');
    }
    const comparison = sourceBoundStorageComparison({ network: expectedNetwork, expectedIdentity, authenticContent: signed.content,
      executedContent: c, authenticated: embedded || projected });
    // Retain the raw mismatch as a repeatable guard witness: only the narrow
    // authenticated comparison projection may turn that mismatch into a pass.
    if (embedded && !demosTransactionContentMatches(signed.content, c, txHash)
      && !demosTransactionContentMatches(signed.content, comparison, txHash)) reject('invalid', 'executed transaction differs from the approved signed projection');
    if (projected && !demosTransactionContentMatches(signed.content, comparison, txHash)) reject('invalid', 'executed transaction differs from the public signed projection');
    if (embedded && projected && canonicalize(signed) !== canonicalize(saved.authorizedTransaction)) reject('invalid', 'public projection differs from the retained wallet authorization');
    const nonce = embedded || projected ? wireInteger(c.nonce) : c.nonce;
    if (c.type !== 'storageProgram' || c.data?.length !== 2 || c.data[0] !== 'storageProgram' || op?.operation !== 'CREATE_STORAGE_PROGRAM'
      || !integer(nonce) || nonce < 1 || op.salt !== '' || op.encoding !== 'json' || op.programName !== logicalToStorageProgramName(logicalAddress)
      || c.to !== native.storageAddress || op.storageAddress !== native.storageAddress || deriveStorageAddress(owner, op.programName, nonce, '') !== native.storageAddress
      || native.owner !== owner || native.programName !== op.programName || canonicalize(native.data) !== canonicalize(op.data)
      || canonicalize(native.metadata) !== canonicalize(op.metadata) || op.metadata?.logicalAddress !== logicalAddress
      || op.metadata?.envelopeHash !== exactHash(native.data) || !HASH.test(op.metadata?.contentHash)) reject('invalid', 'transaction does not bind the logical address, native address and exact readback');
    if (op.metadata.contentHash !== artifactContentHash(native.data, op.metadata.artifactKind)) reject('invalid', 'native artifact content hash differs from the signed metadata');
    if(sourceCapability && (comparison.network!==sourceCapability.pins.network || comparison.chainIdentity!==expectedIdentity || !bindsSourcePin(op.metadata.networkBinding, expectedWriter))) reject('invalid','signed Agreement metadata does not bind the exact source pin');
    // A passive read accepts any writer's record on the approved chain: its endpoint and transport authority are the writer's own.
    if (passive && (comparison.network !== expectedNetwork || comparison.chainIdentity !== expectedIdentity || !sameSharedTuple(op.metadata.networkBinding, identityRecord))) {
      reject('invalid', 'signed CREATE does not bind the approved identity record');
    }
    if (saved && ((!embedded && canonicalize(c) !== canonicalize(saved.payload.content)) || txHash !== saved.authorizationMessage
      || exactHash(native.data) !== saved.envelopeHash || op.metadata.contentHash !== saved.hash || op.metadata.artifactKind !== saved.artifactKind)) reject('invalid', 'transaction differs from the retained wallet plan');
    const block = await nodeCall('getBlockByNumber', { blockNumber: tx.blockNumber });
    if (!object(block) || block.status !== 'confirmed' || block.number !== tx.blockNumber || !HASH.test(block.hash)
      || !integer(block.content?.timestamp) || !Array.isArray(block.content?.ordered_transactions) || !block.content.ordered_transactions.includes(txHash)
      || (live ? (!object(block.validation_data) || Object.keys(block.validation_data).length===0 || (block.validation_data.chainIdentity!==undefined && block.validation_data.chainIdentity!==identity)) : (block.validation_data?.simulated !== true || block.validation_data.chainIdentity !== identity))) reject('invalid', 'observed block does not establish source-bound inclusion');
    const observedAt = now();
    if (!integer(observedAt)) reject('invalid', 'observation timestamp must be a nonnegative integer');
    const finalityProof = canonicalize(block.validation_data);
    const evidence = {
      evidenceVersion: '1', chainIdentity: identity, writer: owner, logicalName: logicalAddress, nativeAddress: native.storageAddress,
      operation: 'create', nonce, transactionRef: txHash, signedTransaction: canonicalize(signed), signedTransactionHash: demosSignedTransactionProofHash(signed),
      blockNumber: tx.blockNumber, blockHash: block.hash, blockTimestamp: block.content.timestamp * 1000,
      finalityProof, finalityProofHash: sha256Hex(finalityProof),
      nativeRead: { owner, programName: native.programName, valueHash: exactHash(native.data), metadataHash: exactHash(native.metadata), observedAt },
    };
    assertDemosWriteEvidence(evidence);
    const receipt = labelReceipt(demosWriteEvidenceToAnchorReceipt({ logicalAddress, contentHash: op.metadata.contentHash, writer: expectedWriter, evidence }), receiptLabels);
    return { status: 'present', artifact: clone(native.data), ...(native.metadata.artifactKind !== undefined ? { artifactKind: native.metadata.artifactKind } : {}), receipt, demosEvidence: evidence, evidenceMode: mode,...(sourceCapability?{networkBinding:clone(sourceCapability.transportBinding)}:{}),...(live?{finality:'not-established'}:{}) };
  }

  async function readCurrent(logicalAddress, { expectedWriter, expectedArtifactKind, expectedDeliveryBinding, signedProjection, nativeAddress } = {}) {
    const projection = signedProjection === undefined ? undefined : clone(signedProjection);
    if (!expectedWriter) reject('writer-required', 'logical readback requires the independently expected writer');
    const native = await resolve(logicalAddress, expectedWriter, nativeAddress ?? projection?.content?.to);
    if (!native) throw Object.assign(new DemosSr2Error('indeterminate','name-index visibility does not establish authenticated absence'),{observation:'name-index-miss'});
    if (expectedArtifactKind !== undefined && native.metadata.artifactKind !== expectedArtifactKind) reject('invalid', 'native readback binds another artifact kind');
    if (expectedDeliveryBinding !== undefined && canonicalize(native.metadata.deliveryBinding) !== canonicalize(expectedDeliveryBinding)) reject('invalid', 'native readback binds another delivery scope');
    const saved = await retained(logicalAddress, expectedWriter);
    // An explicit projection never falls back to mutable public provenance. A
    // wallet-adopted record uses its exact retained authorization message.
    // Fixture/default reads keep their historical rich-projection path.
    const expectedHash = projection !== undefined ? projection?.hash
      : saved?.authorizationProfile === 'embedded-storage-anchor-create' ? saved.authorizationMessage
      : native.createdByTx;
    return authenticate(logicalAddress, expectedWriter, native, expectedHash, saved, projection);
  }

  // `read` also takes the caller's `signal` (see boundedRead).
  const readAuthenticated = (logicalAddress, { signal, ...options } = {}) => boundedRead(() => readCurrent(logicalAddress, options), signal);

  // Fixture evidence leaves this adapter only with the fixture labels, so the
  // core converter and verifier refuse it as chain evidence. Receipt checks
  // below use the unmarked read, which stays internal.
  const markFixtureEvidence = (record) => live ? record
    : { ...record, demosEvidence: { ...record.demosEvidence, state: DEMOS_SR2_FIXTURE_RECEIPT.state, finalityProfile: DEMOS_SR2_FIXTURE_RECEIPT.finalityProfile } };
  const read = async (logicalAddress, options) => markFixtureEvidence(await readAuthenticated(logicalAddress, options));

  // A receipt is decoded only after it carries this adapter's labels; the
  // proof codec reads Demos labels, so it gets a relabelled copy.
  function receiptProof(receipt, expectedWriter, signedProjection) {
    if (!isAnchorReceipt(receipt) || !expectedWriter || receipt.writer !== expectedWriter) reject('invalid', 'an exact writer-bound receipt is required');
    if (!hasReceiptLabels(receipt, receiptLabels)) reject('invalid', `receipt does not carry the ${mode} labels`);
    const proof = decodeDemosAnchorReceiptProof(labelReceipt(receipt, DEMOS_FINALITY_RECEIPT));
    if (proof.chainIdentity !== expectedIdentity || (signedProjection !== undefined && signedProjection?.hash !== receipt.transactionRef.value)) reject('invalid', 'receipt binds another chain or projection');
    return proof;
  }

  // Reauthenticate current inclusion and native state, then compare every
  // labelled receipt field while retaining the original observation timestamp.
  // Returns the fresh authenticated read.
  async function reauthenticate(receipt, { expectedWriter, signedProjection, ...readOptions }) {
    const fresh = await readAuthenticated(receipt.logicalAddress, { ...readOptions, expectedWriter, signedProjection, nativeAddress: receipt.nativeAddress });
    fresh.demosEvidence.nativeRead.observedAt = receipt.observedAt;
    if (!demosWriteEvidenceBindsReceiptContent(fresh.demosEvidence, receipt.logicalAddress, receipt.contentHash)) reject('invalid', 'receipt content hash differs');
    const expected = labelReceipt(demosWriteEvidenceToAnchorReceipt({ logicalAddress: receipt.logicalAddress, contentHash: receipt.contentHash, writer: expectedWriter, evidence: fresh.demosEvidence }), receiptLabels);
    if (canonicalize(expected) !== canonicalize(receipt)) reject('invalid', 'receipt differs from current authenticated evidence');
    return fresh;
  }

  async function recheck(receipt, { expectedWriter, signedProjection } = {}) {
    return boundedRead(async () => {
      receiptProof(receipt, expectedWriter, signedProjection);
      await reauthenticate(receipt, { expectedWriter, signedProjection });
      return { status: 'present', evidenceMode: mode };
    });
  }

  /**
   * Check that `receipt` anchors exactly `artifact` for `expectedWriter`, through
   * the same reauthentication as `recheck`. The artifact's content hash uses
   * its kind's signed scope unless `receiptContentHash` is given. Returns
   * 'valid', 'invalid', or 'indeterminate' when the chain could not be observed;
   * never throws.
   */
  async function verifyReceipt({ receipt, logicalAddress, artifact, expectedWriter, artifactKind, deliveryBinding, receiptContentHash, signedProjection }) {
    try {
      return await boundedRead(async () => {
        const hash = receiptContentHash === undefined ? artifactContentHash(artifact, artifactKind) : receiptContentHash;
        if (!isAnchorReceipt(receipt) || receipt.logicalAddress !== logicalAddress || receipt.contentHash !== hash
          || hash !== artifactContentHash(artifact, artifactKind)) return 'invalid';
        const proof = receiptProof(receipt, expectedWriter, signedProjection);
        const derived = deriveStorageAddress(addressForClaim(expectedWriter), logicalToStorageProgramName(logicalAddress), Number(receipt.nonce), '');
        if (derived !== receipt.nativeAddress || proof.nativeRead.valueHash !== exactHash(artifact)) return 'invalid';
        const fresh = await reauthenticate(receipt, { expectedWriter, signedProjection, expectedArtifactKind: artifactKind, expectedDeliveryBinding: deliveryBinding });
        return exactHash(fresh.artifact) === exactHash(artifact) ? 'valid' : 'invalid';
      });
    } catch (error) {
      return error?.code === 'indeterminate' ? 'indeterminate' : 'invalid';
    }
  }

  return { read, recheck, verifyReceipt };
}
