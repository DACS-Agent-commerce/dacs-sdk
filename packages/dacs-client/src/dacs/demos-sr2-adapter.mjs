// OFFLINE integration adapter, not a live Demos writer. Only marked literal
// loopback reads are permitted. The adapter has no key and never broadcasts.
// It plans immutable CREATEs, authenticates the exact wallet authorization,
// and authenticates SDK-wire fixture inclusion and native readback before
// projecting evidence with the pinned @kynesyslabs/dacs helpers.
//
// The original strict skeleton uses the local `sign` interface and a
// test-owned submitter. A separate explicit storage-anchor handoff may adopt
// the approved SDK envelope from the frozen wallet's injected journal; this
// does not loosen the strict skeleton or authorize any live send.
// The portable SDK receipt says "demos"; its enclosing result always says
// simulated-fixture, and its proof contains fixture validation data. Nothing
// here authenticates real validator signatures, consensus, fees or finality.
import {
  canonicalize, contentHash, isAnchorReceipt, logicalToStorageProgramName, sha256Hex,
  assertDemosWriteEvidence, decodeDemosAnchorReceiptProof,
  demosSignedTransactionProofHash, demosWriteEvidenceBindsReceiptContent,
  demosWriteEvidenceToAnchorReceipt,
} from '@kynesyslabs/dacs';
import { addressForClaim, verifyDemosSignature } from '../signatures.mjs';
import { canonicalSignature } from '../signatures.mjs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from './wallet-transactions.mjs';

// Supported public core helper for signed-to-executed content comparison.
import { demosTransactionContentMatches } from '@kynesyslabs/dacs';
import { isDevnetAgreementTransport } from '../wallet/devnet-native-transport.mjs';

export const DEMOS_SR2_EVIDENCE_MODE = 'explicit-pinned-transport-single-node';
// Terminal stage for an explicitly denied, provably unsigned handoff only.
export const DENIED_UNSIGNED = 'denied-unsigned';
const NATIVE_ADDRESS = /^stor-[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const LITERAL_LOOPBACK = new Set(['127.0.0.1', '[::1]']);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => structuredClone(v);
const exactHash = (v) => sha256Hex(canonicalize(v));
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
  constructor(code, message) { super(message); this.code = code; }
}
const reject = (code, message) => { throw new DemosSr2Error(code, message); };
// An authenticated contradiction: the exact writer's signed CREATE, named by
// the caller (not chosen by the node), verifies (its hash and signature, and
// its source binding) and its content contradicts what the caller pinned. Its
// code is `invalid` like every other refusal; the
// `contradiction` mark is what verifyReceipt answers `invalid` for, and what a
// purchase may end on (the source change). A node answer that does not authenticate, or is
// missing or unconfirmed, is refused unmarked: not established.
const contradict = (message) => { throw demosSr2Contradiction(message); };
export const demosSr2Contradiction = (message) => Object.assign(new DemosSr2Error('invalid', message), { contradiction: true });
export const isDemosSr2Contradiction = (error) => error instanceof DemosSr2Error && error.code === 'invalid' && error.contradiction === true;

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

function descriptor(record) {
  const { planId, logicalAddress, nativeAddress, writer, nonce, hash, envelopeHash, stage, transactionHash } = record;
  return { planId, logicalAddress, nativeAddress, writer, nonce, contentHash: hash, envelopeHash, stage,
    ...(transactionHash ? { transactionHash } : {}), evidenceMode: record.evidenceMode ?? DEMOS_SR2_EVIDENCE_MODE };
}

function inputs({ logicalAddress, artifact, writer, artifactKind, deliveryBinding, receiptContentHash = contentHash(artifact) }) {
  if (typeof logicalAddress !== 'string' || !logicalAddress || logicalAddress.trim() !== logicalAddress) reject('invalid', 'logical address is required');
  const programName = logicalToStorageProgramName(logicalAddress);
  if (programName.length > 256) reject('invalid', 'program name exceeds the offline fixture limit');
  const value = JSON.parse(canonicalize(artifact));
  if (!object(value) || Buffer.byteLength(canonicalize(value)) > 64 * 1024) reject('invalid', 'artifact must be a bounded JSON object');
  if (!HASH.test(receiptContentHash)) reject('invalid', 'receipt content hash must be SHA-256 hex');
  const owner = addressForClaim(writer);
  const envelopeHash = exactHash(value);
  if (artifactKind !== undefined && (typeof artifactKind !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(artifactKind))) reject('invalid', 'explicit artifact kind is malformed');
  if (deliveryBinding !== undefined && (artifactKind !== 'Deliverable' || !object(deliveryBinding))) reject('invalid', 'delivery binding is admitted only for an explicit Deliverable');
  return { logicalAddress, artifact: value, writer, owner, programName, hash: receiptContentHash, envelopeHash,
    ...(artifactKind !== undefined ? { artifactKind } : {}), ...(deliveryBinding !== undefined ? { deliveryBinding:clone(deliveryBinding) } : {}),
    metadata: { logicalAddress, contentHash: receiptContentHash, envelopeHash, ...(artifactKind !== undefined ? { artifactKind } : {}),
      ...(deliveryBinding !== undefined ? { deliveryBinding:clone(deliveryBinding) } : {}) } };
}

export function demosSr2TxRef(receipt) {
  return { kind: 'storage-program', address: receipt.nativeAddress, writeTxHash: receipt.transactionRef.value };
}

export function createDemosSr2Adapter({ rpcUrl, journal, fetchImpl = globalThis.fetch, timeoutMs = 10000, now = () => Date.now(), sourceCapability = null }) {
  if(!isDevnetAgreementTransport(sourceCapability)||typeof sourceCapability.observeBinding!=='function') reject('source-held','an opaque independently supplied Agreement transport is required');
  const endpoint = new URL(rpcUrl);
  if (rpcUrl !== sourceCapability.pins.endpoint) {
    reject('offline-only', 'Demos SR-2 requires a literal HTTP loopback root endpoint');
  }
  if (!journal || ['get', 'put', 'records', 'withWalletLock'].some((k) => typeof journal[k] !== 'function')) reject('journal-required', 'an explicit offline write journal is required');
  const base = endpoint.origin;
  const expectedIdentity=sourceCapability.pins.chainIdentity;
  const mode='explicit-pinned-transport-single-node';
  const scope = canonicalize([base, expectedIdentity,...([sourceCapability.transportBinding.bindingId])]);
  const sourceInputs=(raw)=>{const i=inputs(raw);i.metadata.networkBinding=clone(sourceCapability.transportBinding);return i;};
  const walletKey = (writer) => canonicalize([scope, writer]);
  const ownRecords = async () => (await journal.records()).filter((r) => r.scope === scope);
  const retained = async (logicalAddress, writer) => (await ownRecords()).find((r) => r.logicalAddress === logicalAddress && r.writer === writer);
  async function persist(record) {
    await journal.put(record);
    const readback = await journal.get(record.planId);
    if (!readback || canonicalize(readback) !== canonicalize(record)) reject('journal-error', 'the exact adapter stage was not durably retained');
  }

  async function call(path, body) {
    try {
      return await sourceCapability.readRpc(path,body);

    } catch (error) {
      if (error instanceof DemosSr2Error) throw error;
      reject('indeterminate', `SR-2 observation unavailable: ${error.kind ?? 'transport'}`);
    }
  }
  async function nodeCall(message, data) {
    const answer = await call('/', { method: 'nodeCall', params: [{ message, data }] });
    if (!object(answer) || answer.result !== 200 || !Object.hasOwn(answer, 'response')) reject('indeterminate', 'malformed nodeCall result');
    return answer.response;
  }
  async function chainIdentity() {
    {
      let binding;
      try{binding=await sourceCapability.observeBinding();}
      catch(error){reject('indeterminate',`source-bound chain identity observation unavailable: ${error?.code??'transport'}`);}
      const keys=['bindingId','bindingVersion','chainIdentity','connectionId','endpoint','expiresAt','network','observedAt','pinVersion','source','transportAuthority'];
      if(!object(binding)||JSON.stringify(Object.keys(binding).sort())!==JSON.stringify(keys)
        ||typeof binding.connectionId!=='string'||!binding.connectionId||!object(binding.source)||!integer(binding.observedAt)||!integer(binding.expiresAt)||binding.expiresAt<=binding.observedAt) reject('indeterminate','source-bound chain identity observation is malformed');
      const declaration=sourceCapability.transportBinding;
      if(['bindingVersion','bindingId','network','chainIdentity','pinVersion','endpoint','transportAuthority'].some((key)=>binding[key]!==declaration[key])
        ||binding.chainIdentity!==expectedIdentity) reject('invalid-chain','source-bound chain identity differs');
      return binding.chainIdentity;
    }
  }

  async function nativeRead(address) {
    if (!NATIVE_ADDRESS.test(address)) reject('invalid', 'malformed native address');
    const value = await call(`/storage-program/${address}`);
    if (!object(value) || value.success !== true || value.storageAddress !== address || !object(value.data)
      || typeof value.owner !== 'string' || typeof value.programName !== 'string' || !object(value.metadata)) reject('indeterminate', 'native readback lacks an exact address, owner, data or metadata');
    return value;
  }

  // Do not guess a nonce-derived physical address for another writer. Search
  // all bounded pages, then authenticate EACH native candidate and its owner.
  async function resolve(logicalAddress, expectedWriter) {
    const owner = addressForClaim(expectedWriter);
    const programName = logicalToStorageProgramName(logicalAddress);
    await chainIdentity();
    const candidates = new Map();
    let complete = false;
    for (let page = 0; page < 8; page += 1) {
      const rows = await nodeCall('searchStoragePrograms', { query: programName, options: { exactMatch: true, limit: 50, offset: page * 50 } });
      if (!Array.isArray(rows) || rows.length > 50) reject('indeterminate', 'malformed name-index page');
      for (const row of rows) {
        if (!object(row) || !NATIVE_ADDRESS.test(row.storageAddress) || typeof row.programName !== 'string') reject('indeterminate', 'malformed name-index candidate');
        if (row.programName === programName) candidates.set(row.storageAddress, row);
      }
      if (rows.length < 50) { complete = true; break; }
    }
    if (!complete) reject('indeterminate', 'name index exceeds the bounded pagination limit');
    const saved = await retained(logicalAddress, expectedWriter);
    if (saved) candidates.set(saved.nativeAddress, { programName });
    const owned = [];
    for (const [address] of candidates) {
      const native = await nativeRead(address);
      if (native.programName !== programName) reject('invalid', 'name index and native program name differ');
      if (native.owner !== owner) continue;
      if (native.metadata.logicalAddress !== logicalAddress) reject('invalid', 'native metadata names another logical address');
      owned.push(native);
    }
    if (owned.length > 1) reject('indeterminate', 'multiple programs belong to this logical address and writer');
    if (owned.length === 0 && saved) reject('indeterminate', 'retained handoff has no authenticated native readback');
    return owned[0] ?? null;
  }

  // pinned: the caller named txHash (a projection, a retained embedded plan, a
  // receipt or a write pointer). Otherwise the node chose it (createdByTx), and
  // a writer-signed CREATE it names is not the writer's claim about this
  // address: its content is refused unmarked, never a contradiction (the source change).
  async function authenticate(logicalAddress, expectedWriter, native, txHash, saved = null, signedProjection, pinned = true) {
    const identity = await chainIdentity();
    if (!HASH.test(txHash)) reject('invalid', 'transaction hash must be SHA-256 hex');
    // Preserve the historical fail-closed ordering for a rich projection: a
    // changed receipt pointer must be rejected before attempting to fetch it.
    // The paired-absent case proceeds only because its authority is supplied
    // independently and authenticated below.
    // Every refusal keeps its code for read/write callers. Only a contradiction
    // in the authenticated signed CREATE is also marked (contradict): node
    // data (native readback, executed content, block) and a signature or hash
    // that does not verify establish nothing and contradict nothing.
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
    // Authenticate before judging content: signed bytes that hash to txHash, the
    // exact writer's signature over that hash, and the node's transaction under
    // it. An answer that fails this (no content, other bytes, a signature that
    // does not verify) establishes nothing, so it contradicts nothing either.
    if (!object(signed) || !object(signed.content) || tx.hash !== txHash || !object(c) || signed.hash !== txHash
      || sha256Hex(JSON.stringify(signed.content)) !== txHash || signed.signature?.type !== 'ed25519' || !object(tx.signature) || canonicalize(tx.signature) !== canonicalize(signed.signature)
      || !verifyDemosSignature({ address: owner, message: txHash, signature: tx.signature.data })) reject('invalid', 'transaction lacks the exact writer authorization');
    // Without a projection or retained authorization, the executed content is
    // the signed content itself; otherwise it is the node's rendering of it.
    const executedIsSigned = !embedded && !projected;
    const unmarked = (message) => reject('invalid', message);
    const mark = pinned ? contradict : unmarked;
    if (signed.content.from !== owner) mark('transaction lacks the exact writer authorization');
    if (c.from !== owner || c.from_ed25519_address !== owner) (executedIsSigned ? mark : unmarked)('transaction lacks the exact writer authorization');
    const comparison = sourceBoundStorageComparison({ sourceCapability, expectedIdentity, authenticContent: signed.content,
      executedContent: c, authenticated: embedded || projected });
    // Retain the raw mismatch as a repeatable guard witness: only the narrow
    // authenticated comparison projection may turn that mismatch into a pass.
    if (embedded && !demosTransactionContentMatches(signed.content, c, txHash)
      && !demosTransactionContentMatches(signed.content, comparison, txHash)) reject('invalid', 'executed transaction differs from the approved signed projection');
    if (projected && !demosTransactionContentMatches(signed.content, comparison, txHash)) reject('invalid', 'executed transaction differs from the public signed projection');
    if (embedded && projected && canonicalize(signed) !== canonicalize(saved.authorizedTransaction)) reject('invalid', 'public projection differs from the retained wallet authorization');
    // The source binding is part of authentication: a CREATE bound to another
    // network or pin is not this chain's record.
    // A CREATE with no metadata binding keeps this refusal's code (canonicalize
    // throws a code-less error for an absent value).
    if(sourceCapability && (comparison.network!==sourceCapability.pins.network || comparison.chainIdentity!==expectedIdentity || op?.metadata?.networkBinding===undefined || canonicalize(op.metadata.networkBinding)!==canonicalize(sourceCapability.transportBinding))) reject('invalid','signed Agreement metadata does not bind the exact source pin');
    // Authenticated from here. The signed CREATE itself contradicts the logical
    // address, its own native address or its own envelope: the writer's fault.
    const nonce = embedded || projected ? wireInteger(c.nonce) : c.nonce;
    if (c.type !== 'storageProgram' || c.data?.length !== 2 || c.data[0] !== 'storageProgram' || op?.operation !== 'CREATE_STORAGE_PROGRAM'
      || !integer(nonce) || nonce < 1 || op.salt !== '' || op.encoding !== 'json' || op.programName !== logicalToStorageProgramName(logicalAddress)
      || c.to !== op.storageAddress || deriveStorageAddress(owner, op.programName, nonce, '') !== op.storageAddress
      || op.metadata?.logicalAddress !== logicalAddress || op.metadata?.envelopeHash !== exactHash(op.data) || !HASH.test(op.metadata?.contentHash)) mark('transaction does not bind the logical address, native address and exact readback');
    // The native readback must show exactly that CREATE; if it does not, the
    // node's answer is not established (refused, not a contradiction).
    if (!creationProvenanceMatches(native, txHash, Boolean(sourceCapability) && (embedded || projected))) {
      reject('invalid', 'native creation provenance does not bind the authenticated transaction');
    }
    if (native.storageAddress !== op.storageAddress || native.owner !== owner || native.programName !== op.programName
      || canonicalize(native.data) !== canonicalize(op.data) || canonicalize(native.metadata) !== canonicalize(op.metadata)) reject('invalid', 'transaction does not bind the logical address, native address and exact readback');
    if (saved && ((!embedded && canonicalize(c) !== canonicalize(saved.payload.content)) || txHash !== saved.authorizationMessage
      || exactHash(native.data) !== saved.envelopeHash || op.metadata.contentHash !== saved.hash || op.metadata.artifactKind !== saved.artifactKind)) reject('invalid', 'transaction differs from the retained wallet plan');
    // Block facts are node data too: a missing, unconfirmed or inconsistent
    // block does not establish inclusion (refused, not a contradiction).
    const block = await nodeCall('getBlockByNumber', { blockNumber: tx.blockNumber });
    if (!object(block) || block.status !== 'confirmed' || block.number !== tx.blockNumber || !HASH.test(block.hash)
      || !integer(block.content?.timestamp) || !Array.isArray(block.content?.ordered_transactions) || !block.content.ordered_transactions.includes(txHash)
      || ((!object(block.validation_data) || Object.keys(block.validation_data).length===0 || (block.validation_data.chainIdentity!==undefined && block.validation_data.chainIdentity!==identity)))) reject('invalid', 'observed block does not establish source-bound inclusion');
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
    const receipt = demosWriteEvidenceToAnchorReceipt({ logicalAddress, contentHash: op.metadata.contentHash, writer: expectedWriter, evidence });
    return { status: 'present', artifact: clone(native.data), ...(native.metadata.artifactKind !== undefined ? { artifactKind: native.metadata.artifactKind } : {}), receipt, demosEvidence: evidence, evidenceMode: mode,...({networkBinding:clone(sourceCapability.transportBinding),finality:'not-established'}) };
  }

  async function read(logicalAddress, { expectedWriter, expectedArtifactKind, expectedDeliveryBinding, signedProjection } = {}) {
    const projection = signedProjection === undefined ? undefined : clone(signedProjection);
    if (!expectedWriter) reject('writer-required', 'logical readback requires the independently expected writer');
    const native = await resolve(logicalAddress, expectedWriter);
    if (!native) return { status: 'absent', evidenceMode: mode };
    const saved = await retained(logicalAddress, expectedWriter);
    // An explicit projection never falls back to mutable public provenance. A
    // wallet-adopted record uses its exact retained authorization message.
    // Fixture/default reads keep their historical rich-projection path.
    const embedded = saved?.authorizationProfile === 'embedded-storage-anchor-create';
    const expectedHash = projection !== undefined ? projection?.hash
      : embedded ? saved.authorizationMessage
      : native.createdByTx;
    const pinned = projection !== undefined || embedded;
    const record = await authenticate(logicalAddress, expectedWriter, native, expectedHash, saved, projection, pinned);
    // The metadata now equals the authenticated CREATE's: another kind or
    // delivery scope there is the writer's contradiction, when the caller
    // pinned that CREATE (a node-chosen one is refused unmarked).
    const mark = pinned ? contradict : (message) => reject('invalid', message);
    if (expectedArtifactKind !== undefined && native.metadata.artifactKind !== expectedArtifactKind) mark('native readback binds another artifact kind');
    if (expectedDeliveryBinding !== undefined && canonicalize(native.metadata.deliveryBinding) !== canonicalize(expectedDeliveryBinding)) mark('native readback binds another delivery scope');
    return record;
  }

  // Current-state half of `read` for a receipt this adapter already
  // authenticated: the name-index search, native GET, and the data, metadata,
  // owner and creation-provenance comparison. It skips only the transaction and
  // block authentication pinned by the receipt's block hash, so it cannot see
  // a reorg that leaves this exact program in place. `resolve` pins the
  // owner, program name and logical address; the metadata hash pins the kind.
  async function recheck(receipt, { expectedWriter, signedProjection } = {}) {
    const proof = decodeDemosAnchorReceiptProof(receipt);
    const txHash = receipt.transactionRef.value;
    const projected = signedProjection !== undefined;
    if (proof.chainIdentity !== expectedIdentity || (projected && signedProjection?.hash !== txHash)) reject('invalid', 'receipt binds another chain or projection');
    const native = await resolve(receipt.logicalAddress, expectedWriter);
    if (!native) return { status: 'absent', evidenceMode: mode };
    if (native.storageAddress !== receipt.nativeAddress
      || exactHash(native.data) !== proof.nativeRead.valueHash || exactHash(native.metadata) !== proof.nativeRead.metadataHash
      || !creationProvenanceMatches(native, txHash, Boolean(sourceCapability) && projected)) reject('invalid', 'current native readback differs from the authenticated receipt');
    return { status: 'present', evidenceMode: mode };
  }

  async function planWrite(input) {
    const requested = sourceInputs(input);
    return journal.withWalletLock(walletKey(requested.writer), async () => {
      const saved = await retained(requested.logicalAddress, requested.writer);
      if (saved) {
        if (saved.envelopeHash !== requested.envelopeHash || saved.hash !== requested.hash || saved.artifactKind !== requested.artifactKind) reject('conflict', 'immutable logical address already has different content or kind');
        return descriptor(saved);
      }
      const existing = await read(requested.logicalAddress, { expectedWriter: requested.writer });
      if (existing.status === 'present') {
        if (exactHash(existing.artifact) !== requested.envelopeHash || existing.receipt.contentHash !== requested.hash) reject('conflict', 'immutable native record already has different content');
        const complete = { ...requested, scope, planId: exactHash([scope, requested.writer, requested.logicalAddress]), nativeAddress: existing.receipt.nativeAddress,
          nonce: Number(existing.receipt.nonce), stage: 'verified', transactionHash: existing.receipt.transactionRef.value,
          payload: { content: JSON.parse(existing.demosEvidence.signedTransaction).content }, authorizationMessage: existing.receipt.transactionRef.value };
        await persist(complete);
        return descriptor(complete);
      }
      if ((await ownRecords()).some((r) => r.writer === requested.writer && !['verified', DENIED_UNSIGNED].includes(r.stage))) reject('wallet-fenced', 'another unresolved wallet handoff owns the nonce lane');
      const current = await nodeCall('getAddressNonce', { address: requested.owner });
      if (!integer(current) || !Number.isSafeInteger(current + 1)) reject('indeterminate', 'account nonce is unavailable or exhausted');
      const nonce = current + 1;
      const nativeAddress = deriveStorageAddress(requested.owner, requested.programName, nonce, '');
      const timestamp = now();
      if (!integer(timestamp)) reject('invalid', 'plan timestamp must be a nonnegative integer');
      const payload = buildStorageProgramCreatePayload({ from: requested.owner, storageAddress: nativeAddress, programName: requested.programName,
        logicalAddress: requested.logicalAddress, signedListing: requested.artifact, nonce, timestamp });
      payload.content.data[1].metadata = clone(requested.metadata);
      payload.content.from_ed25519_address = requested.owner;
      const authorizationMessage = sha256Hex(JSON.stringify(payload.content));
      const record = { ...requested, scope, planId: exactHash([scope, requested.writer, requested.logicalAddress]), nativeAddress, nonce,
        stage: 'prepared', payload, authorizationMessage,...({evidenceMode:mode}) };
      await persist(record);
      return descriptor(record);
    });
  }

  async function takeWalletHandoff({ planId, walletAddress }) {
    const saved = await journal.get(planId);
    if (!saved || saved.scope !== scope) reject('invalid', 'unknown wallet plan');
    return journal.withWalletLock(walletKey(saved.writer), async () => {
      const current = await journal.get(planId);
      if (walletAddress !== current.owner) reject('wrong-writer', 'handoff belongs to another wallet');
      if (current.stage !== 'prepared') reject('handoff-already-issued', 'this plan cannot issue another wallet handoff');
      await chainIdentity();
      const nonce = await nodeCall('getAddressNonce', { address: current.owner });
      if (!integer(nonce)) reject('indeterminate', 'account nonce is unavailable');
      if (nonce + 1 !== current.nonce) reject('stale-plan', 'wallet nonce changed after planning');
      // Persist before returning. Unknown outcomes remain fenced forever until
      // authenticated readback; there is no reset/re-send method here.
      current.stage = 'handoff-issued';
      await persist(current);
      return { ...descriptor(current), request: { method: 'sign', params: [current.authorizationMessage] },
        unsignedTransaction: clone(current.payload), integration: 'local-sign-only; embedded-sendTransaction-held' };
    });
  }

  async function authorizeWrite({ planId, walletAddress, writerSignature }) {
    const saved = await journal.get(planId);
    if (!saved || saved.scope !== scope) reject('invalid', 'unknown wallet plan');
    return journal.withWalletLock(walletKey(saved.writer), async () => {
      const current = await journal.get(planId);
      if (walletAddress !== current.owner || !verifyDemosSignature({ address: current.owner, message: current.authorizationMessage, signature: writerSignature })) reject('wrong-writer', 'wallet did not authorize these exact bytes');
      if (current.stage !== 'handoff-issued') reject('authorization-already-issued', 'the signed envelope cannot be issued again');
      const signedTransaction = clone(current.payload);
      signedTransaction.hash = current.authorizationMessage;
      signedTransaction.signature = { type: 'ed25519', data: `0x${Buffer.from(canonicalSignature(writerSignature), 'base64url').toString('hex')}` };
      current.stage = 'authorization-issued';
      await persist(current);
      return { ...descriptor(current), signedTransaction };
    });
  }

  // Consume a pointer, never submit a transaction. A missing/uncertain read
  // throws indeterminate and keeps the wallet lane and original plan fenced.
  async function write({ logicalAddress, artifact, writer, artifactKind, deliveryBinding, transactionHash, receiptContentHash = contentHash(artifact) }) {
    const requested = sourceInputs({ logicalAddress, artifact, writer, artifactKind, deliveryBinding, receiptContentHash });
    return journal.withWalletLock(walletKey(writer), async () => {
      const saved = await retained(logicalAddress, writer);
      if (!saved || saved.envelopeHash !== requested.envelopeHash || saved.hash !== requested.hash || saved.artifactKind !== requested.artifactKind) reject('conflict', 'write requires the exact retained wallet plan');
      if (!['authorization-issued', 'verified'].includes(saved.stage)) reject('authorization-required', 'exact wallet authorization has not been established');
      if (saved.transactionHash && saved.transactionHash !== transactionHash) reject('invalid', 'verified transaction pointer cannot change');
      const native = await nativeRead(saved.nativeAddress);
      const record = await authenticate(logicalAddress, writer, native, transactionHash, saved);
      saved.stage = 'verified';
      saved.transactionHash = transactionHash;
      await persist(saved);
      return record.receipt;
    });
  }

  // The receipt is first checked against the request with no read: a receipt
  // that does not describe this artifact is invalid, as before. After that,
  // `invalid` only for an authenticated contradiction: the exact writer's
  // signed CREATE named by this receipt verifies and contradicts the artifact,
  // its kind, delivery scope or content hash. Anything that depends on a node
  // answer is otherwise `indeterminate` (the source change): a node answer that does not
  // authenticate or is missing or unconfirmed, another chain identity (node or
  // pin data, not the record), block facts that differ from the receipt, a
  // local fault, or any foreign error.
  async function verifyReceipt({ receipt, logicalAddress, artifact, expectedWriter, artifactKind, deliveryBinding, receiptContentHash = contentHash(artifact), signedProjection }) {
    try {
      const projection = signedProjection === undefined ? undefined : clone(signedProjection);
      if (!isAnchorReceipt(receipt) || receipt.logicalAddress !== logicalAddress || receipt.writer !== expectedWriter || receipt.contentHash !== receiptContentHash) return 'invalid';
      const proof = decodeDemosAnchorReceiptProof(receipt);
      if (proof.chainIdentity !== expectedIdentity || proof.operation !== 'create') return 'invalid';
      const derived = deriveStorageAddress(addressForClaim(expectedWriter), logicalToStorageProgramName(logicalAddress), Number(receipt.nonce), '');
      if (derived !== receipt.nativeAddress || proof.nativeRead.valueHash !== exactHash(artifact)) return 'invalid';
      const native = await nativeRead(receipt.nativeAddress);
      const record = await authenticate(logicalAddress, expectedWriter, native, receipt.transactionRef.value, await retained(logicalAddress, expectedWriter), projection);
      // Authenticated: the native metadata and data equal the signed CREATE's.
      if (artifactKind !== undefined && native.metadata.artifactKind !== artifactKind) contradict('the authenticated CREATE binds another artifact kind');
      if (deliveryBinding !== undefined && canonicalize(native.metadata.deliveryBinding) !== canonicalize(deliveryBinding)) contradict('the authenticated CREATE binds another delivery scope');
      if (exactHash(artifact) !== exactHash(record.artifact)) contradict('the authenticated CREATE holds another artifact');
      const expected = record.receipt;
      // observedAt is the original observation, not this reauthentication's
      // wall clock. Every other field must match fresh inclusion/native facts.
      record.demosEvidence.nativeRead.observedAt = receipt.observedAt;
      if (!demosWriteEvidenceBindsReceiptContent(record.demosEvidence, logicalAddress, receiptContentHash)) contradict('the authenticated CREATE binds another content hash');
      // The rest of the receipt (block, proof hashes, nonce) is compared with
      // fresh node facts that are not signed: a difference is not established.
      const reprojection = demosWriteEvidenceToAnchorReceipt({ logicalAddress, contentHash: receiptContentHash, writer: expectedWriter, evidence: record.demosEvidence });
      return canonicalize(reprojection) === canonicalize(receipt) && expected.nativeAddress === receipt.nativeAddress ? 'valid' : 'indeterminate';
    } catch (error) {
      return isDemosSr2Contradiction(error) ? 'invalid' : 'indeterminate';
    }
  }

  // Separate handoff for the frozen explicit wallet kind. The old skeleton
  // authorizer is unchanged; it never accepts SDK-added fields implicitly.
  async function takeStorageAnchorHandoff({ planId, walletAddress, network }) {
    if (typeof network !== 'string' || !/^[a-z0-9._-]{1,64}$/.test(network)) reject('invalid', 'an explicit fixture network label is required');
    const saved = await journal.get(planId);
    if (!saved || saved.scope !== scope) reject('invalid', 'unknown wallet plan');
    return journal.withWalletLock(walletKey(saved.writer), async () => {
      const current = await journal.get(planId);
      if (walletAddress !== current.owner) reject('wrong-writer', 'handoff belongs to another wallet');
      if (current.stage !== 'prepared') reject('handoff-already-issued', 'this plan cannot issue another wallet handoff');
      await chainIdentity();
      const nonce = await nodeCall('getAddressNonce', { address: current.owner });
      if (!integer(nonce) || nonce + 1 !== current.nonce) reject('stale-plan', 'wallet nonce differs from the retained plan');
      current.payload.content.network = network;
      if(sourceCapability && network!==sourceCapability.pins.network) reject('invalid-chain','the CREATE network differs from the opaque source capability');
      current.payload.content.chainIdentity = expectedIdentity;
      current.authorizationProfile = 'embedded-storage-anchor-create';
      current.stage = 'handoff-issued';
      await persist(current);
      return { ...descriptor(current), unsignedTransaction: clone(current.payload) };
    });
  }

  // The caller must supply the exact signed/approved envelope retained by the
  // injected wallet journal, not an RPC body or an untrusted hash pointer.
  async function adoptWalletAuthorization({ planId, walletRecord }) {
    const saved = await journal.get(planId);
    if (!saved || saved.scope !== scope) reject('invalid', 'unknown wallet plan');
    return journal.withWalletLock(walletKey(saved.writer), async () => {
      const current = await journal.get(planId);
      const signed = walletRecord?.signedTransaction;
      const approved = walletRecord?.approved;
      const c = signed?.content;
      if (current.authorizationProfile !== 'embedded-storage-anchor-create' || !['handoff-issued', 'authorization-issued', 'verified'].includes(current.stage)) reject('authorization-required', 'no explicit embedded wallet handoff was retained');
      if (!['broadcast-started', 'sr2-readback-pending', 'broadcast-accepted'].includes(walletRecord?.stage)
        || !object(approved) || !object(approved.transaction?.content) || !object(c) || approved.owner !== current.writer || approved.logicalAddress !== current.logicalAddress
        || approved.contentHash !== current.hash || approved.envelopeHash !== current.envelopeHash || (current.artifactKind !== undefined && approved.artifactKind !== current.artifactKind)
        || canonicalize(approved.transaction?.content) !== canonicalize(current.payload.content)
        || signed.hash !== walletRecord.hash || !HASH.test(signed.hash) || sha256Hex(JSON.stringify(c)) !== signed.hash
        || signed.signature?.type !== 'ed25519' || !verifyDemosSignature({ address: current.owner, message: signed.hash, signature: signed.signature.data })) reject('authorization-required', 'the exact approved wallet signature and journal record are required');
      const initial = current.payload.content;
      if (c.from !== current.owner || c.from_ed25519_address !== current.owner || c.to !== current.nativeAddress || c.nonce !== current.nonce
        || c.timestamp !== initial.timestamp || wireInteger(c.amount) !== 0 || c.network !== initial.network || c.chainIdentity !== initial.chainIdentity
        || canonicalize(c.data) !== canonicalize(initial.data) || !Array.isArray(c.gcr_edits) || c.gcr_edits.length !== 4) reject('invalid', 'the signed SDK CREATE differs from its retained scope or coordinate');
      if (current.authorizedTransaction && canonicalize(current.authorizedTransaction) !== canonicalize(signed)) reject('invalid', 'retained wallet authorization cannot change');
      current.authorizedTransaction = clone(signed);
      current.authorizationMessage = signed.hash;
      if (current.stage !== 'verified') current.stage = 'authorization-issued';
      await persist(current);
      return descriptor(current);
    });
  }

  // Terminal retirement of one explicitly denied, never-authorized embedded
  // handoff. Under the writer's lane lock it requires: the exact retained plan
  // at `handoff-issued` with no adopted authorization, the caller's proof that
  // no signed wallet record exists for it (read inside this lock), an empty
  // exact name index for its program, and an account nonce that has not
  // consumed the plan's nonce (a later plan reuses that nonce, so the two can
  // never both apply). Any
  // other state, or any unavailable observation, rejects and stays fenced. The
  // record is kept (never deleted) and can never issue, adopt or write again.
  async function retireDeniedHandoff({ logicalAddress, writer, walletAddress, provesUnsigned }) {
    if (typeof provesUnsigned !== 'function') reject('invalid', 'an unsigned-lane proof is required');
    return journal.withWalletLock(walletKey(writer), async () => {
      const current = await retained(logicalAddress, writer);
      if (!current || walletAddress !== current.owner) reject('invalid', 'no exact retained plan for this writer');
      if (current.stage === DENIED_UNSIGNED) return descriptor(current);
      if (current.stage !== 'handoff-issued' || current.authorizationProfile !== 'embedded-storage-anchor-create' || current.authorizedTransaction) reject('authorization-required', 'only an unauthorized issued handoff can be retired');
      if (await provesUnsigned(clone(current)) !== true) reject('authorization-required', 'a signed wallet record may exist for this handoff');
      await chainIdentity();
      const rows = await nodeCall('searchStoragePrograms', { query: current.programName, options: { exactMatch: true, limit: 50, offset: 0 } });
      if (!Array.isArray(rows) || rows.length !== 0) reject('indeterminate', 'the name index does not prove the program absent');
      const nonce = await nodeCall('getAddressNonce', { address: current.owner });
      if (!integer(nonce) || nonce + 1 !== current.nonce) reject('indeterminate', 'account nonce does not prove the handoff unconsumed');
      current.stage = DENIED_UNSIGNED;
      current.retirement = { reason: 'explicit-wallet-denial-without-signed-record', observedAccountNonce: nonce };
      await persist(current);
      return descriptor(current);
    });
  }

  return { rpcOrigin: base, evidenceMode: DEMOS_SR2_EVIDENCE_MODE, planWrite, takeWalletHandoff, authorizeWrite, takeStorageAnchorHandoff, adoptWalletAuthorization, retireDeniedHandoff, read, recheck, write, verifyReceipt };
}
