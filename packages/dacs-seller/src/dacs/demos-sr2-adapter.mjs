// Offline SR-2 fixture readback authenticates exact CREATE authorization,
// confirmed inclusion and native contents. Literal marked loopback replies
// establish simulated-fixture evidence only, never real consensus or finality:
// their receipts carry the DEMOS_SR2_FIXTURE_RECEIPT labels, not Demos ones.
// The adapter owns no key and never broadcasts.
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  attestationBundleHash, canonicalize, contentHash, identityBundleHash,
  isAnchorReceipt, logicalToStorageProgramName, sha256Hex,
  assertDemosWriteEvidence, decodeDemosAnchorReceiptProof,
  demosSignedTransactionProofHash, demosWriteEvidenceBindsReceiptContent,
  demosWriteEvidenceToAnchorReceipt,
} from '@kynesyslabs/dacs';
import { fetchBoundedJson } from '../util/http.mjs';
import { addressForClaim, verifyDemosSignature } from './demos-claims.mjs';
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
const MAX_NATIVE_CANDIDATES = 32;
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
// projected/retained authorization binds the current source admission. Raw
// content is never a source of missing authorization and no input is mutated.
function sourceBoundStorageComparison({ sourceCapability, expectedIdentity, authenticContent, executedContent, authenticated }) {
  if (!sourceCapability || !authenticated || !object(authenticContent) || !object(executedContent)) return executedContent;
  const authenticBinding = typeof authenticContent.network === 'string' && authenticContent.network.length > 0
    && authenticContent.network === sourceCapability.pins.network
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

export function createDemosSr2Adapter({ rpcUrl, journal, fetchImpl = globalThis.fetch, timeoutMs = 10000, now = () => Date.now(), sourceCapability = null }) {
  if(sourceCapability !== null && (!isDevnetAgreementTransport(sourceCapability)||typeof sourceCapability.observeBinding!=='function')) reject('source-held','an opaque independently supplied Agreement transport is required');
  const endpoint = new URL(rpcUrl);
  if (sourceCapability ? rpcUrl !== sourceCapability.pins.endpoint : (endpoint.protocol !== 'http:' || !LITERAL_LOOPBACK.has(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/')) {
    reject('offline-only', 'Demos SR-2 requires a literal HTTP loopback root endpoint');
  }
  if (!journal || ['records'].some((k) => typeof journal[k] !== 'function')) reject('journal-required', 'an explicit readback journal is required');
  const base = endpoint.origin;
  const expectedIdentity=sourceCapability?.pins.chainIdentity ?? DEMOS_SR2_FIXTURE_CHAIN_IDENTITY;
  const mode=sourceCapability ? 'explicit-pinned-transport-single-node' : DEMOS_SR2_EVIDENCE_MODE;
  const receiptLabels = sourceCapability ? DEMOS_FINALITY_RECEIPT : DEMOS_SR2_FIXTURE_RECEIPT;
  const scope = canonicalize([base, expectedIdentity,...(sourceCapability?[sourceCapability.transportBinding.bindingId]:[])]);
  const ownRecords = async () => (await journal.records()).filter((r) => r.scope === scope);
  const retained = async (logicalAddress, writer) => (await ownRecords()).find((r) => r.logicalAddress === logicalAddress && r.writer === writer);
  const readBudget = new AsyncLocalStorage();
  async function boundedRead(work) {
    if (readBudget.getStore()) return work();
    const controller = new AbortController();
    const cause = new DOMException('SR-2 aggregate read deadline exceeded', 'TimeoutError');
    let timer;
    const deadline = new Promise((_, fail) => { timer = setTimeout(() => {
      controller.abort(cause); fail(new DemosSr2Error('indeterminate', cause.message, { cause }));
    }, timeoutMs); });
    try { return await readBudget.run(controller.signal, () => Promise.race([work(), deadline])); }
    finally { clearTimeout(timer); controller.abort(); }
  }

  async function call(path, body) {
    try {
      const signal = readBudget.getStore(); signal?.throwIfAborted();
      if(sourceCapability) return await sourceCapability.readRpc(path,body,{signal,maxBytes:DEMOS_SR2_REPLY_BYTES,timeoutMs});
      return await fetchBoundedJson(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST', body, timeoutMs, maxBytes: DEMOS_SR2_REPLY_BYTES, expectedOrigin: base,
        fetchImpl: async (url, options) => {
          const signal = readBudget.getStore(); signal?.throwIfAborted();
          const response = await fetchImpl(url, { ...options, signal: signal ? AbortSignal.any([signal, options.signal]) : options.signal });
          signal?.throwIfAborted();
          if (response.headers.get('x-dacs-simulation') !== 'fixture') {
            await response.body?.cancel().catch(() => {});
            reject('indeterminate', 'every SR-2 response must carry the simulation marker');
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
  async function chainIdentity() {
    readBudget.getStore()?.throwIfAborted();
    if(sourceCapability){
      let binding;
      try{binding=await sourceCapability.observeBinding();}
      catch(error){reject('indeterminate',`source-bound chain identity observation unavailable: ${error?.message??'transport'}`,{cause:error,status:error?.status});}
      const keys=['bindingId','bindingVersion','chainIdentity','connectionId','endpoint','expiresAt','network','observedAt','pinVersion','source','transportAuthority'];
      if(!object(binding)||JSON.stringify(Object.keys(binding).sort())!==JSON.stringify(keys)
        ||typeof binding.connectionId!=='string'||!binding.connectionId||!object(binding.source)||!integer(binding.observedAt)||!integer(binding.expiresAt)||binding.expiresAt<=binding.observedAt) reject('indeterminate','source-bound chain identity observation is malformed');
      const declaration=sourceCapability.transportBinding;
      if(['bindingVersion','bindingId','network','chainIdentity','pinVersion','endpoint','transportAuthority'].some((key)=>binding[key]!==declaration[key])
        ||binding.chainIdentity!==expectedIdentity) reject('invalid-chain','source-bound chain identity differs');
      return binding.chainIdentity;
    }
    const genesis = await nodeCall('getBlockByNumber', { blockNumber: 0 });
    if (genesis?.number !== 0 || genesis.status !== 'confirmed' || genesis.hash !== expectedIdentity) reject('invalid-chain', 'source-bound chain identity differs');
    return genesis.hash;
  }
  async function nativeRead(address) {
    if (!NATIVE_ADDRESS.test(address)) reject('invalid', 'malformed native address');
    const value = await call(`/storage-program/${address}`);
    if (!object(value) || value.success !== true || value.storageAddress !== address
      || typeof value.owner !== 'string' || typeof value.programName !== 'string') reject('indeterminate', 'native readback lacks an exact address, owner, data or metadata');
    return value;
  }

  // Do not guess a nonce-derived physical address for another writer. Search
  // all bounded pages, then authenticate EACH native candidate and its owner.
  // A supplied native address is one more candidate, never a skipped search.
  async function resolve(logicalAddress, expectedWriter, nativeAddress) {
    const owner = addressForClaim(expectedWriter);
    const programName = logicalToStorageProgramName(logicalAddress);
    await chainIdentity();
    const candidates = new Map();
    let complete = false;
    if (nativeAddress !== undefined) { if (!NATIVE_ADDRESS.test(nativeAddress)) reject('invalid', 'malformed supplied native address'); candidates.set(nativeAddress, { programName }); }
    for (let page = 0; page < 8 && !complete; page += 1) {
      const rows = await nodeCall('searchStoragePrograms', { query: programName, options: { exactMatch: true, limit: 50, offset: page * 50 } });
      if (!Array.isArray(rows) || rows.length > 50) reject('indeterminate', 'malformed name-index page');
      for (const row of rows) {
        if (!object(row) || !NATIVE_ADDRESS.test(row.storageAddress) || typeof row.programName !== 'string') reject('indeterminate', 'malformed name-index candidate');
        if (row.programName === programName) candidates.set(row.storageAddress, row);
        if (candidates.size > MAX_NATIVE_CANDIDATES) reject('indeterminate', 'native candidate budget exceeded');
      }
      if (rows.length < 50) { complete = true; break; }
    }
    if (!complete) reject('indeterminate', 'name index exceeds the bounded pagination limit');
    const saved = await retained(logicalAddress, expectedWriter);
    if (saved) candidates.set(saved.nativeAddress, { programName });
    if (candidates.size > MAX_NATIVE_CANDIDATES) reject('indeterminate', 'native candidate budget exceeded');
    const owned = [];
    for (const [address] of candidates) {
      const native = await nativeRead(address);
      if (native.programName !== programName) reject('invalid', 'name index and native program name differ');
      if (native.owner !== owner) continue;
      if (!object(native.data) || !object(native.metadata)) reject('invalid', 'owned native record lacks DACS payload or metadata');
      if (native.metadata.logicalAddress !== logicalAddress) reject('invalid', 'native metadata names another logical address');
      owned.push(native);
    }
    if (owned.length > 1) reject('indeterminate', 'multiple programs belong to this logical address and writer');
    if (owned.length === 0 && saved) reject('indeterminate', 'retained handoff has no authenticated native readback');
    return owned[0] ?? null;
  }

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
    const embedded = saved?.authorizationProfile === 'embedded-storage-anchor-create';
    // Public evidence is data, never a retained wallet authorization. A caller
    // may supply the original signed CREATE when RPC normalizes executed fields;
    // it must pass the same signature, projection and fresh native checks.
    const projected = signedProjection !== undefined;
    const signed = projected ? signedProjection : embedded ? saved.authorizedTransaction : { hash: tx.hash, content: c, signature: tx.signature };
    if (!object(signed) || !object(signed.content) || tx.hash !== txHash || !object(c) || signed.hash !== txHash
      || sha256Hex(JSON.stringify(signed.content)) !== txHash || signed.signature?.type !== 'ed25519' || !object(tx.signature) || canonicalize(tx.signature) !== canonicalize(signed.signature)
      || signed.content.from !== owner || c.from !== owner || c.from_ed25519_address !== owner
      || !verifyDemosSignature({ address: owner, message: txHash, signature: tx.signature.data })) reject('invalid', 'transaction lacks the exact writer authorization');
    if (!creationProvenanceMatches(native, txHash, Boolean(sourceCapability) && (embedded || projected))) {
      reject('invalid', 'native creation provenance does not bind the authenticated transaction');
    }
    const comparison = sourceBoundStorageComparison({ sourceCapability, expectedIdentity, authenticContent: signed.content,
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
    if(sourceCapability && (comparison.network!==sourceCapability.pins.network || comparison.chainIdentity!==expectedIdentity || canonicalize(op.metadata.networkBinding)!==canonicalize(sourceCapability.transportBinding))) reject('invalid','signed Agreement metadata does not bind the exact source pin');
    if (saved && ((!embedded && canonicalize(c) !== canonicalize(saved.payload.content)) || txHash !== saved.authorizationMessage
      || exactHash(native.data) !== saved.envelopeHash || op.metadata.contentHash !== saved.hash || op.metadata.artifactKind !== saved.artifactKind)) reject('invalid', 'transaction differs from the retained wallet plan');
    const block = await nodeCall('getBlockByNumber', { blockNumber: tx.blockNumber });
    if (!object(block) || block.status !== 'confirmed' || block.number !== tx.blockNumber || !HASH.test(block.hash)
      || !integer(block.content?.timestamp) || !Array.isArray(block.content?.ordered_transactions) || !block.content.ordered_transactions.includes(txHash)
      || (sourceCapability ? (!object(block.validation_data) || Object.keys(block.validation_data).length===0 || (block.validation_data.chainIdentity!==undefined && block.validation_data.chainIdentity!==identity)) : (block.validation_data?.simulated !== true || block.validation_data.chainIdentity !== identity))) reject('invalid', 'observed block does not establish source-bound inclusion');
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
    return { status: 'present', artifact: clone(native.data), ...(native.metadata.artifactKind !== undefined ? { artifactKind: native.metadata.artifactKind } : {}), receipt, demosEvidence: evidence, evidenceMode: mode,...(sourceCapability?{networkBinding:clone(sourceCapability.transportBinding),finality:'not-established'}:{}) };
  }

  async function readCurrent(logicalAddress, { expectedWriter, expectedArtifactKind, expectedDeliveryBinding, signedProjection, nativeAddress } = {}) {
    const projection = signedProjection === undefined ? undefined : clone(signedProjection);
    if (!expectedWriter) reject('writer-required', 'logical readback requires the independently expected writer');
    const native = await resolve(logicalAddress, expectedWriter, nativeAddress ?? projection?.content?.to);
    if (!native) reject('indeterminate', 'name-index visibility does not establish authenticated absence');
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

  const read = (logicalAddress, options) => boundedRead(() => readCurrent(logicalAddress, options));

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
    const fresh = await read(receipt.logicalAddress, { ...readOptions, expectedWriter, signedProjection, nativeAddress: receipt.nativeAddress });
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
