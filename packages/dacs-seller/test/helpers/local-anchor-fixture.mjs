// TEST-only immutable anchor using the shipped fixture authorization profile.
// Fixed wallet signatures authorize exact addresses and hashes; no node or key
// provider is supplied by this helper.
import { contentHash, storAddress } from '@kynesyslabs/dacs';
import { verifyDemosSignature, addressForClaim } from '../../src/dacs/demos-claims.mjs';
import { canonicalSignature as encodeSignature, FIXTURE_SUBSTRATE, FIXTURE_FINALITY, anchorWriteMessage, fixtureWriteHash } from '../../src/dacs/fixture-anchors.mjs';
export { fixtureRef, signAnchorWrite, canonicalSignature, verifyFixtureReceipt, verifyFixtureRecord } from '../../src/dacs/fixture-anchors.mjs';
export const fixtureTxRef = receipt => ({ kind: 'demos', txHash: receipt.transactionRef.value, blockNumber: Number(receipt.blockRef.height) });
export function localAnchor({ now }) {
  const rows = new Map(), writes = [], controls = { state: 'finalized', timestamp: null, read: row => row, failAfterWrite: null };
  const write = async ({ logicalAddress, artifact, writer, writerSignature }) => {
    const hash = contentHash(artifact);
    if (!verifyDemosSignature({ address: addressForClaim(writer), message: anchorWriteMessage(logicalAddress, hash), signature: writerSignature })) throw new Error('invalid TEST writer authorization');
    if (rows.has(logicalAddress)) throw new Error('immutable TEST address already written');
    const canonicalSignature = encodeSignature(writerSignature);
    const tx = fixtureWriteHash({ logicalAddress, contentHash: hash, writer, writerSignature: canonicalSignature });
    const receipt = { receiptVersion: '1', substrate: FIXTURE_SUBSTRATE, finalityProfile: FIXTURE_FINALITY, logicalAddress, nativeAddress: storAddress(logicalAddress),
      contentHash: hash, writer, transactionRef: { kind: 'fixture-sr2-write', value: tx }, state: controls.state, observationDisposition: 'established', observedAt: now(),
      blockRef: { id: tx, height: String(rows.size + 1), timestamp: controls.timestamp ?? now() }, evidence: { kind: 'fixture-writer-signature', value: canonicalSignature } };
    rows.set(logicalAddress, { status: 'present', artifact: structuredClone(artifact), receipt }); writes.push(logicalAddress);
    if (controls.failAfterWrite === logicalAddress) { controls.failAfterWrite = null; throw new Error('TEST lost anchor answer'); }
    return structuredClone(receipt);
  };
  return { rows, writes, controls, write, read: async address => controls.read(structuredClone(rows.get(address) ?? { status: 'absent' }), address) };
}
