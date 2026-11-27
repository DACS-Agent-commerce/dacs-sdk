// Unshipped test helper: the inputs of a direct node qualification read over the client's scripted node: a bound owner, the
// client's registered read-only observer source over it, and the reviewed build's evidence for the owner's endpoint on a test clock.
import { api, ENDPOINT, nodeConnection, replayNode, T0 } from './seller-node-wallet-world.mjs';
import { shippedEvidenceReader } from './shipped-build-evidence.mjs';

/** How long the reviewed build's evidence stays current: 30 days, in milliseconds. */
export const EVIDENCE_MAX_AGE_MS = 2_592_000_000;

/**
 * Binds an owner over `node` (a fresh replay node by default), builds the observer source over it and resolves the connection's
 * members with `inputs`: `{binding, currentLocal, observer, source, clock, readDeploymentEvidence}` (the reviewed build's evidence
 * unless `readDeploymentEvidence` is given). `t.after` closes the owner.
 */
export async function qualificationInputs(t, { node = replayNode(), clock = { now: () => T0 }, readDeploymentEvidence } = {}) {
  const connection = await nodeConnection(node);
  t.after(() => connection.owner.close());
  const { observer, source, currentLocal } = await api.createQualificationObserverSource({ owner: connection.owner, binding: connection.admission.binding, clock });
  const inputs = { binding: connection.admission.binding, currentLocal, observer, source, clock,
    readDeploymentEvidence: readDeploymentEvidence ?? shippedEvidenceReader({ endpoint: ENDPOINT, clock }) };
  return { ...connection, inputs };
}
