// The seller agent's effect signatures (the Agreement co-signature, the commitment, settlement evidence, the
// evidence and the audit-source commitment) are each made inside one sign pass of the host's effect boundary.
// The key's effect role is called only from that pass's synchronous inner signer, once, over the exact bytes.
import { sha256Hex } from '@kynesyslabs/dacs';

/** The boundary operation a job's effect signature (and the answer that carries it) runs under: lane `job-<jobId>`. */
export const agentEffectOperation = ({ jobId, operationId, k1Rev = null, pinVersion }) => ({
  operationId, lane: `job-${jobId}`, kind: 'wire-request', paidWrite: false, debitOs: null, approvalRef: null, k1Rev, pinVersion,
});

// A signer for one call: it signs `exact` once, only while the pass's inner signer runs, and only with the effect role.
function passSignerFor(effectSigner, exact) {
  let open = false, used = false;
  const passSigner = (bytes) => {
    if (!open || used || !Buffer.from(bytes).equals(exact)) throw new TypeError('the pass signer signs its own bytes once, inside its pass');
    used = true;
    return effectSigner.sign(Uint8Array.from(exact));
  };
  const during = (work) => { open = true; try { return work(); } finally { open = false; } };
  return { passSigner, during };
}

/**
 * Builds the agent's signing helper over `effectBoundary` (the host's boundary), `effectSigner` (the key's effect role,
 * `{ sign(bytes) }`), `durable` (the seller's durable state, or null) and `pinVersion` (the boundary binding's).
 * `sign(bytes, { jobId, recheck, k1Rev })` runs `recheck()` (the caller's synchronous signing-time checks), then one
 * sign pass for the operation `signature-<sha256 of bytes>` on lane `job-<jobId>`. Its inner signer runs `recheck()`
 * again and then `durable.signOnce` (or the effect role directly without durable state), with nothing awaited
 * between them. A signature the pass or the durable state already retains is returned without signing again.
 * Resolves the signature bytes. Rejects with `recheck`'s error, the boundary's WireError or the durable state's error.
 */
export function createAgentEffectSigner({ effectBoundary, effectSigner, durable, pinVersion }) {
  return async function sign(bytes, { jobId, recheck = () => {}, k1Rev = null }) {
    const exact = Buffer.from(bytes);
    const bytesHash = sha256Hex(exact);
    recheck();
    const { passSigner, during } = passSignerFor(effectSigner, exact);
    const innerSign = () => during(() => {
      recheck();
      return new Uint8Array(durable ? durable.signOnce(`signature:${bytesHash}`, exact, passSigner) : passSigner(exact));
    });
    const op = agentEffectOperation({ jobId, operationId: `signature-${bytesHash}`, k1Rev, pinVersion });
    return (await effectBoundary.signPass(op, innerSign)).bytes;
  };
}
