// Opt-in seller capability: read and authenticate the buyer's Agreement as the
// native Demos SR-2 storage CREATE written by the buyer's packaged wallet
// through its source-pinned browser broker / wallet bridge profile.
//
// It consumes the existing SR-2 adapter only (demos-sr2-adapter.mjs `read` and
// `verifyReceipt`, the same verification the buyer bridge uses) over a
// seller-private, read-only journal, so the seller never inherits the buyer's
// retained wallet plan. A present answer requires: an exact native record at
// the canonical Agreement logical address owned by the expected buyer writer,
// artifact kind `Agreement`, a receipt bound to the artifact's SDK contentHash,
// and `verifyReceipt(...) === 'valid'` (fresh inclusion + native readback). Any
// incomplete observation is `indeterminate`; any mismatch is `rejected`. Nothing
// here writes, signs or broadcasts. Evidence mode is an explicit source-pinned
// single-node observation; independent finality is not established.
import { contentHash } from '@kynesyslabs/dacs';
import { demosSr2TxRef, DEMOS_SR2_EVIDENCE_MODE, isDemosSr2Contradiction } from './demos-sr2-adapter.mjs';

export const SELLER_SR2_AGREEMENT_SOURCE = 'demos-sr2-storage-create';
export const SELLER_SR2_PUBLIC_PROJECTION = 'public-signed-create';
const ARTIFACT_KIND = 'Agreement';
const held = (disposition, reason) => ({ disposition, reason: String(reason).slice(0, 240) });
const contradicted = reason => ({ ...held('rejected', reason), authenticated: true });
const readError = (error, step) => {
  const reason = `SR-2 Agreement ${step}: ${error?.code ?? 'error'}: ${error?.message ?? error}`;
  return isDemosSr2Contradiction(error) ? contradicted(reason) : held('indeterminate', reason);
};

// The caller supplies the existing native read-only adapter.
export function createSellerSr2AgreementAnchor({ reader } = {}) {
  const adapter = reader;
  if (typeof adapter?.read !== 'function' || typeof adapter.verifyReceipt !== 'function') throw new TypeError('an SR-2 reader with read and verifyReceipt is required');

  async function readAgreement({ logicalAddress, writer, agreementHash, signedProjection }) {
    let record;
    try {
      record = await adapter.read(logicalAddress, { expectedWriter: writer, expectedArtifactKind: ARTIFACT_KIND, ...(signedProjection === undefined ? {} : { signedProjection }) });
    } catch (error) {
      return readError(error, 'read');
    }
    if (record?.status === 'absent') return held('absent', 'no native Agreement at the canonical address for this buyer');
    if (record?.status !== 'present' || !record.receipt || !record.artifact) return held('indeterminate', 'SR-2 Agreement read returned no exact native record');
    const artifact = record.artifact;
    const hash = contentHash(artifact);
    if (record.artifactKind !== ARTIFACT_KIND || record.receipt.contentHash !== hash || (agreementHash !== undefined && hash !== agreementHash)) {
      return contradicted('native Agreement kind or content hash differs from the contributed Agreement');
    }
    let verdict;
    try { verdict = await adapter.verifyReceipt({ receipt: record.receipt, logicalAddress, artifact, expectedWriter: writer, artifactKind: ARTIFACT_KIND, receiptContentHash: hash, ...(signedProjection === undefined ? {} : { signedProjection }) }); }
    catch (error) { return readError(error, 'receipt verification'); }
    if (verdict !== 'valid') return verdict === 'invalid' ? contradicted(`SR-2 Agreement receipt is ${verdict}`) : held('indeterminate', `SR-2 Agreement receipt is ${verdict}`);
    return {
      disposition: 'present',
      artifact,
      // SDK reference shape: logical locator + signed-scope content hash.
      ref: { anchor: { kind: 'storage-program', locator: logicalAddress }, contentHash: hash },
      native: { source: SELLER_SR2_AGREEMENT_SOURCE, evidenceMode: record.evidenceMode ?? DEMOS_SR2_EVIDENCE_MODE, nativeAddress: record.receipt.nativeAddress, txRef: demosSr2TxRef(record.receipt), receipt: record.receipt },
    };
  }

  // Current state of an Agreement whose `receipt` this reader already
  // verified: the adapter's storage search, native GET and exact comparison,
  // without re-authenticating the pinned transaction and block.
  async function recheckAgreement({ logicalAddress, writer, agreementHash, signedProjection, receipt }) {
    if (typeof adapter.recheck !== 'function') return held('indeterminate', 'this SR-2 reader cannot recheck current Agreement state');
    if (receipt?.logicalAddress !== logicalAddress || receipt.contentHash !== agreementHash) return held('indeterminate', 'the supplied receipt names another Agreement');
    let record;
    try {
      record = await adapter.recheck(receipt, { expectedWriter: writer, ...(signedProjection === undefined ? {} : { signedProjection }) });
    } catch (error) {
      return readError(error, 'recheck');
    }
    if (record?.status === 'absent') return held('absent', 'no native Agreement at the canonical address for this buyer');
    return record?.status === 'present' ? { disposition: 'present' } : held('indeterminate', 'SR-2 Agreement recheck returned no exact native record');
  }

  return Object.freeze({ source: SELLER_SR2_AGREEMENT_SOURCE, readAgreement, recheckAgreement });
}
