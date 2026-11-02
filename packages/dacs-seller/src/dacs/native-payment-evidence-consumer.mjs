// Run-time port of http-mcp/src/dacs/native-payment-evidence-consumer.mjs at
// DACS-Agent-commerce/frontend 15fdf23: the whole file.
// Consumed, opt-in SOURCE/loopback capability. SDK intake's bft-final field
// describes the fixture node's included view, NOT independent consensus.
import { contentHash, createPayDemSellerObserver, paymentEvidenceAddress, verifySettlementEvidence } from '@kynesyslabs/dacs';
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal, DEMOS_SR2_REPLY_BYTES } from './demos-sr2-adapter.mjs';
import { agreementTerms, ed25519Deps } from './purchase-protocol.mjs';
import { isDevnetSettlementTransport } from './devnet-source.mjs';

export const NATIVE_PAYMENT_EVIDENCE = 'sdk-pay-dem-intake-native-evidence/loopback-v1';
const capabilities = new WeakSet();
export function nativePaymentEvidenceConfig(value) {
  if (value == null) return null;
  if (!capabilities.has(value)) throw new TypeError('nativePaymentEvidence requires an explicit constructed loopback consumer capability, not approval or verified-status flags');
  return value;
}
export const usesNativePaymentEvidence = (op) => op?.terms?.protocol?.nativePaymentEvidence === NATIVE_PAYMENT_EVIDENCE;

// A signed CREATE projection is checked before the adapter clones it: a plain
// object whose JSON fits one node reply. A projection that cannot serialize is
// refused the same way.
function boundedProjection(projection) {
  if (projection === null || typeof projection !== 'object' || Object.getPrototypeOf(projection) !== Object.prototype) return false;
  try { return Buffer.byteLength(JSON.stringify(projection)) <= DEMOS_SR2_REPLY_BYTES; } catch { return false; }
}

// No missing/malformed/unknown answer is interpreted as true absence. This
// classifier does not establish validity; present records still need all the
// independent native/signature/tuple checks below.
export function nativeEvidenceReadOutcome(record) {
  if (record?.status === 'present') return null;
  const nativeReadStatus = record?.status ?? 'missing';
  return { disposition: nativeReadStatus === 'absent' ? 'absent' : 'indeterminate',
    nativeReadStatus, reason: String(record?.reason ?? (nativeReadStatus === 'absent' ? 'native-payment-evidence-not-anchored' : 'native-payment-evidence-read-incomplete')).slice(0,240),
    ...(record?.code ? { code: record.code } : {}) };
}

// Independently derive the verifier context from the retained signed Agreement
// and the buyer's observed tuple; the seller's HTTP answer is not a verdict.
export async function checkNativePaymentEvidence({ artifact, agreement, writer, txHash, blockNumber }) {
  const terms = agreementTerms(agreement);
  const address = paymentEvidenceAddress(agreement.jobId, terms.rail, terms.paymentPhaseIndex);
  const ref = { anchor: { kind: 'storage-program', locator: address }, contentHash: contentHash(artifact) };
  if (writer !== terms.seller || artifact.jobId !== agreement.jobId || artifact.phase !== 'pay-dem'
      || artifact.outcome !== 'success' || artifact.paymentTxRefs?.length !== 1
      || artifact.paymentTxRefs[0].kind !== 'demos' || artifact.paymentTxRefs[0].txHash !== txHash
      || artifact.paymentTxRefs[0].blockNumber !== blockNumber || artifact.paymentAmount?.amount !== terms.price.amount
      || artifact.paymentAmount?.currency !== 'DEM' || artifact.settlementFinality?.model !== 'bft-final'
      || artifact.signature?.signer !== writer) return { decision: 'fail', reasons: ['native-payment-evidence-scope-mismatch'] };
  return verifySettlementEvidence(artifact, { orchestrator: writer,
    agreement: { amount: terms.price.amount, currency: terms.price.currency },
    rail: { railId: terms.rail, railType: 'demos-native', asset: 'DEM', assetSpec: { kind: 'native-dem' }, network: 'demos', networkSpec: { kind: 'demos' }, handler: 'pay-dem' },
    attestationRef: ref, result: { ok: true, txRefs: [{ kind: 'demos', txHash, blockNumber }] },
    paymentAddress: { railId: terms.rail, phaseIndex: terms.paymentPhaseIndex } }, ed25519Deps);
}

// `anchorEvidence` is a narrow operator-owned wallet boundary, never a buyer
// key or Boolean authority. Tests call the unchanged packaged wallet bridge.
// Reader and observer always use the actual pinned SDK/adapter on this origin.
export function createNativePaymentEvidenceConsumer({ rpcUrl, sourceCapability = null, anchorEvidence, readSignedProjection, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const rpc = new URL(rpcUrl);
  const source = sourceCapability !== null;
  if (source && (!isDevnetSettlementTransport(sourceCapability) || rpc.href !== sourceCapability.pins.endpoint)) throw new TypeError('native payment evidence requires the exact opaque SettlementEvidence source capability');
  if ((!source && (rpc.protocol !== 'http:' || rpc.hostname !== '127.0.0.1')) || rpc.username || rpc.password || rpc.pathname !== '/' || rpc.search || rpc.hash) throw new TypeError('native payment evidence requires owned literal loopback or the exact opaque source');
  if (anchorEvidence !== undefined && typeof anchorEvidence !== 'function') throw new TypeError('anchorEvidence must be a wallet capability');
  if (readSignedProjection !== undefined && typeof readSignedProjection !== 'function') throw new TypeError('readSignedProjection must be an explicit read-only public seller journal capability');
  const fixtureFetch = async (url, init) => {
    const response = await fetchImpl(url, { ...init, redirect: 'error' });
    if (!source && response.headers.get('x-dacs-simulation') !== 'fixture') throw new Error('native evidence requires the owned simulation marker');
    return response;
  };
  const sourceReader = source ? sourceCapability.chainReader() : null;
  const observer = source ? { observeDemosTransfer: (hash) => sourceReader.observeTransfer(hash) } : createPayDemSellerObserver({ rpc: rpc.href, fetchImpl: fixtureFetch });
  const memory = createInMemoryDemosSr2Journal();
  const adapter = createDemosSr2Adapter({ rpcUrl: rpc.href, sourceCapability, now, fetchImpl: fixtureFetch,
    journal: { ...memory, put: async () => { throw new Error('native evidence reader cannot write'); } } });
  const capability = Object.freeze({ source: NATIVE_PAYMENT_EVIDENCE, rpcOrigin: rpc.origin,
    observeDemosTransfer: observer.observeDemosTransfer,
    anchorEvidence,
    // answerProjectionOnly (DACS_BUYER_CHAIN_READBACK=on): the buyer never asks
    // the seller's wallet journal. Only the bytes it was given (its own retained
    // ones or the seller answer's) are authenticated; with none it is unknown.
    async readEvidence({ agreement, writer, txHash, blockNumber, committedAt, signedProjection, retainedReceipt, answerProjectionOnly = false }) {
      const terms = agreementTerms(agreement);
      const address = paymentEvidenceAddress(agreement.jobId, terms.rail, terms.paymentPhaseIndex);
      try {
        // Only public signed CREATE bytes are recovered. A retained wallet
        // status is not evidence and this callback cannot grant another send.
        // Proof evidence canonicalizes JSON for its own hash. That text is
        // NOT a lossless projection of SDK JSON.stringify(content) signing
        // order. Recover the original public transaction from the explicit
        // scoped journal where available; never rewrite content or its hash.
        const retainedProjection = readSignedProjection && !answerProjectionOnly ? await readSignedProjection({ jobId: agreement.jobId, logicalAddress: address, writer }) : undefined;
        const projection = retainedProjection ?? signedProjection;
        if (answerProjectionOnly && !projection) return { disposition: 'indeterminate', nativeReadStatus: 'public-projection-missing', reason: 'original-public-signed-create-projection-unavailable' };
        if (projection && !boundedProjection(projection)) return { disposition: 'indeterminate', nativeReadStatus: 'public-projection-malformed', reason: 'signed-create-projection-not-a-bounded-plain-object' };
        const record = await adapter.read(address, { expectedWriter: writer, expectedArtifactKind: 'SettlementEvidence', ...(projection ? { signedProjection: projection } : {}) });
        const incomplete = nativeEvidenceReadOutcome(record);
        if (incomplete) return answerProjectionOnly && incomplete.disposition === 'absent' ? { ...incomplete, disposition: 'indeterminate' } : incomplete;
        // answerProjectionOnly: the bytes it was given have now authenticated on
        // chain, so a rejection from here on is about what they read back.
        const decided = (result) => answerProjectionOnly && result.disposition === 'rejected' ? { ...result, authenticated: true } : result;
        const validity = await adapter.verifyReceipt({ receipt: record.receipt, logicalAddress: address, artifact: record.artifact, expectedWriter: writer, artifactKind: 'SettlementEvidence', ...(projection ? { signedProjection: projection } : {}) });
        if (validity !== 'valid') return { disposition: 'indeterminate', nativeReadStatus: `receipt-${validity}`, reason: `native-payment-evidence-receipt-${validity}` };
        if(retainedReceipt!==undefined){const retainedValidity=await adapter.verifyReceipt({receipt:retainedReceipt,logicalAddress:address,artifact:record.artifact,expectedWriter:writer,artifactKind:'SettlementEvidence',...(projection?{signedProjection:projection}:{})});if(retainedValidity!=='valid')return decided({disposition:retainedValidity==='invalid'?'rejected':'indeterminate',reason:'native-retained-receipt-'+retainedValidity});}
        const check = await checkNativePaymentEvidence({ artifact: record.artifact, agreement, writer, txHash, blockNumber });
        if (check.decision !== 'pass') return decided({ disposition: 'rejected', reason: check.reasons.join('; ') });
        const observed = await observer.observeDemosTransfer(txHash);
        const raw = (claim) => claim.replace(/^did:demos:agent:/, '').replace(/^0x/, '').toLowerCase();
        if (observed.status !== 'included') return { disposition: 'indeterminate', nativeReadStatus: `payment-${observed.status ?? 'missing'}`, reason: observed.reason ?? 'native-payment-observation-not-included' };
        if (!Number.isSafeInteger(committedAt) || observed.txHash !== txHash || observed.blockNumber !== blockNumber
            || observed.payer !== raw(terms.buyer) || observed.payee !== raw(terms.payee) || observed.amountOs !== terms.price.amountOs
            || observed.includedAt < committedAt || observed.includedAt > terms.deadline || record.artifact.observedAt !== observed.includedAt
            || record.artifact.settlementFinality.finalityObservedAt !== observed.includedAt) return { disposition: 'indeterminate', reason: 'native-evidence-observed-tuple-time-or-commitment-mismatch' };
        if (!projection) return { disposition:'indeterminate',nativeReadStatus:'public-projection-missing',reason:'original-public-signed-create-projection-unavailable' };
        return { disposition: 'present', artifact: record.artifact, ref: { anchor: { kind: 'storage-program', locator: address }, contentHash: contentHash(record.artifact) }, receipt: record.receipt,
          signedProjection: JSON.parse(JSON.stringify(projection)),
          evidenceMode: source ? 'explicit-pinned-source; one-node-included-view; not-independent-finality' : 'simulated-fixture; one-node-included-view; not-independent-finality' };
      } catch (error) { return { disposition: 'indeterminate', nativeReadStatus: error.code ?? 'error',
        ...(error.code ? { code:error.code } : {}), ...(['name-index-miss','native-address-miss'].includes(error.observation)?{nativeObservation:error.observation}:{}), reason: String(error.message).slice(0,240) }; }
    } });
  capabilities.add(capability);
  return capability;
}
