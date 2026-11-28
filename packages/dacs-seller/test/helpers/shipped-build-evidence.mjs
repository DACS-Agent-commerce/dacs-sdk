// Unshipped test helper: deployment evidence of the reviewed testnet node build. Its values are a literal copy of the signed
// record in vectors/testnet-records/deployment-record.json, never read from the shipped QUALIFIED_NODE_BUILDS, so a change to
// the shipped list fails every test that writes through the real gate.

/** The recorded reviewed build: the seven fields a reviewed build entry holds. */
export const RECORDED_REVIEWED_BUILD = Object.freeze({
  chainIdentity: 'd59b54c2f70305e03d3a7e4d469f38295ffe4e4a62cb59b9f887057d0e5ca4bc',
  reportedVersion: '0.9.9 RC',
  commit: 'e6af8f4023fa4e77f482503dae97f1ca00834bf9',
  artifactSha256: 'c75d2b327254e70152de16747760c78415199e47a1e440e16a3ed2f27f8ae5fb',
  dirty: true,
  qualifiedOperations: Object.freeze(['broadcast', 'confirmation', 'fee', 'nonce']),
  evidenceMaxAgeMs: 2_592_000_000,
});

/** A fresh eight-key evidence value of the recorded build for the serving `endpoint`, observed at `observedAt`. */
export function shippedBuildEvidence({ endpoint, observedAt }) {
  const { dirty, commit, artifactSha256, reportedVersion, chainIdentity, qualifiedOperations } = RECORDED_REVIEWED_BUILD;
  return { dirty, commit, artifactSha256, reportedVersion, chainIdentity, qualifiedOperations: [...qualifiedOperations], endpoint, observedAt };
}

/** A host `readDeploymentEvidence({signal})` answering shippedBuildEvidence for `endpoint` at `clock.now()`; an aborted signal throws. */
export const shippedEvidenceReader = ({ endpoint, clock }) => ({ signal } = {}) => {
  signal?.throwIfAborted();
  return shippedBuildEvidence({ endpoint, observedAt: clock.now() });
};
