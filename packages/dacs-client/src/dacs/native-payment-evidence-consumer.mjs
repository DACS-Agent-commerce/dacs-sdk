// Consumed, opt-in SOURCE/loopback capability. SDK intake's bft-final field
// describes one node's included view, NOT independent consensus.
import { contentHash, paymentEvidenceAddress, verifySettlementEvidence } from '@kynesyslabs/dacs';
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal, isDemosSr2Contradiction } from './demos-sr2-adapter.mjs';
import { agreementTerms, ed25519Deps } from './purchase-protocol.mjs';
import { isDevnetSettlementTransport } from '../wallet/devnet-native-transport.mjs';

export const NATIVE_PAYMENT_EVIDENCE = 'sdk-pay-dem-intake-native-evidence/loopback-v1';
const capabilities = new WeakSet();
export function nativePaymentEvidenceConfig(value) {
  if (value == null) return null;
  if (!capabilities.has(value)) throw new TypeError('nativePaymentEvidence requires an explicit constructed loopback consumer capability, not approval or verified-status flags');
  return value;
}
export const usesNativePaymentEvidence = (op) => op?.terms?.protocol?.nativePaymentEvidence === NATIVE_PAYMENT_EVIDENCE;

// No missing/malformed/unknown answer is interpreted as true absence. This
// classifier does not establish validity; present records still need all the
// independent native/signature/tuple checks below.
export function nativeEvidenceReadOutcome(record) {
  if (record?.status === 'present') return null;
  const nativeReadStatus = record?.status ?? 'missing';
  return { disposition: nativeReadStatus === 'absent' ? 'absent' : ['invalid', 'rejected'].includes(nativeReadStatus) && record.authenticated === true ? 'rejected' : 'indeterminate',
    ...(record?.authenticated === true ? { authenticated: true } : {}),
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
export function createNativePaymentEvidenceConsumer({ rpcUrl, sourceCapability = null, anchorEvidence, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const rpc = new URL(rpcUrl);
  if (!sourceCapability) throw new TypeError('native payment evidence requires its source capability');
  if ((!isDevnetSettlementTransport(sourceCapability) || rpc.href !== sourceCapability.pins.endpoint)) throw new TypeError('native payment evidence requires the exact opaque SettlementEvidence source capability');
  if (rpc.username || rpc.password || rpc.pathname !== '/' || rpc.search || rpc.hash) throw new TypeError('native payment evidence requires the exact opaque source');
  if (anchorEvidence !== undefined && typeof anchorEvidence !== 'function') throw new TypeError('anchorEvidence must be a wallet capability');
  const sourceReader = sourceCapability.chainReader();
  const observer = { observeDemosTransfer: (hash) => sourceReader.observeTransfer(hash) };
  const memory = createInMemoryDemosSr2Journal();
  const adapter = createDemosSr2Adapter({ rpcUrl: rpc.href, sourceCapability, now, fetchImpl,
    journal: { ...memory, put: async () => { throw new Error('native evidence reader cannot write'); } } });
  const capability = Object.freeze({ source: NATIVE_PAYMENT_EVIDENCE, rpcOrigin: rpc.origin,
    observeDemosTransfer: observer.observeDemosTransfer,
    anchorEvidence,
    // Chain readback: the buyer never asks
    // the seller's wallet journal. Only the bytes it was given (its own retained
    // ones or the seller answer's) are authenticated; with none it is unknown.
    async readEvidence({ agreement, writer, txHash, blockNumber, committedAt, signedProjection }) {
      const terms = agreementTerms(agreement);
      const address = paymentEvidenceAddress(agreement.jobId, terms.rail, terms.paymentPhaseIndex);
      try {
        // Only public signed CREATE bytes are recovered. A retained wallet
        // status is not evidence and this callback cannot grant another send.
        // Proof evidence canonicalizes JSON for its own hash. That text is
        // NOT a lossless projection of SDK JSON.stringify(content) signing
        // order. Recover the original public transaction from the explicit
        // scoped journal where available; never rewrite content or its hash.
        const projection = signedProjection;
        if (!projection) return { disposition: 'indeterminate', nativeReadStatus: 'public-projection-missing', reason: 'original-public-signed-create-projection-unavailable' };
        const record = await adapter.read(address, { expectedWriter: writer, expectedArtifactKind: 'SettlementEvidence', ...(projection ? { signedProjection: projection } : {}) });
        const incomplete = nativeEvidenceReadOutcome(record);
        if (incomplete) return incomplete.disposition === 'absent' ? { ...incomplete, disposition: 'indeterminate' } : incomplete;
        // Receipt and artifact contradictions concern authenticated bytes.
        // A separate fresh transfer response still has one-node authority only.
        const decided = (result) => result.disposition === 'rejected' ? { ...result, authenticated: true } : result;
        const validity = await adapter.verifyReceipt({ receipt: record.receipt, logicalAddress: address, artifact: record.artifact, expectedWriter: writer, artifactKind: 'SettlementEvidence', ...(projection ? { signedProjection: projection } : {}) });
        if (validity !== 'valid') return decided({ disposition: validity === 'invalid' ? 'rejected' : 'indeterminate', nativeReadStatus: `receipt-${validity}`, reason: `native-payment-evidence-receipt-${validity}` });
        const check = await checkNativePaymentEvidence({ artifact: record.artifact, agreement, writer, txHash, blockNumber });
        if (check.decision !== 'pass') return decided({ disposition: 'rejected', reason: check.reasons.join('; ') });
        const observed = await observer.observeDemosTransfer(txHash);
        const raw = (claim) => claim.replace(/^did:demos:agent:/, '').replace(/^0x/, '').toLowerCase();
        if (observed.status !== 'included') return { disposition: 'indeterminate', nativeReadStatus: `payment-${observed.status ?? 'missing'}`, reason: observed.reason ?? 'native-payment-observation-not-included' };
        if (!Number.isSafeInteger(committedAt) || observed.txHash !== txHash || observed.blockNumber !== blockNumber
            || observed.payer !== raw(terms.buyer) || observed.payee !== raw(terms.payee) || observed.amountOs !== terms.price.amountOs
            || observed.includedAt < committedAt || observed.includedAt > terms.deadline || record.artifact.observedAt !== observed.includedAt
            || record.artifact.settlementFinality.finalityObservedAt !== observed.includedAt) return { disposition: 'indeterminate', nativeReadStatus: 'payment-tuple-unconfirmed', reason: 'native-evidence-observed-tuple-time-or-commitment-mismatch' };
        if (!projection) return { disposition:'indeterminate',nativeReadStatus:'public-projection-missing',reason:'original-public-signed-create-projection-unavailable' };
        return { disposition: 'present', artifact: record.artifact, ref: { anchor: { kind: 'storage-program', locator: address }, contentHash: contentHash(record.artifact) }, receipt: record.receipt,
          signedProjection: JSON.parse(JSON.stringify(projection)),
          evidenceMode: 'explicit-pinned-source; one-node-included-view; not-independent-finality' };
      } catch (error) {
        // Only the adapter's own authenticated contradiction is terminal.
        const authenticated = isDemosSr2Contradiction(error);
        return { disposition: authenticated ? 'rejected' : 'indeterminate', nativeReadStatus: error?.code ?? 'error',
          ...(authenticated ? { authenticated: true } : {}),
          ...(error?.code ? { code:error.code } : {}), reason: String(error?.message ?? error).slice(0,240) }; }
    } });
  capabilities.add(capability);
  return capability;
}
