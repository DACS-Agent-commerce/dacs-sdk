// Unshipped fixture: an agent that is given the first admission the context route makes before its first proposal. A proposal never
// admits a presentation itself, so a test of the agent's Vet, rail and signing steps needs the job's presentation accepted in the ledger first.
// The wrapper attempts the issued challenge on the context path, reads the agent's session admission, and accepts or fails the challenge it owns.
import { canonicalize, identityBundleHash, sha256Hex } from '@kynesyslabs/dacs';

/** The scope hash challenges issued by these fixtures carry. */
export const FIRST_ADMISSION_SCOPE = sha256Hex('TEST first admission scope');

/**
 * Returns `agent` with `receiveProposal` admitting an issued challenge first, for a job with no accepted presentation.
 * `ledger` is the challenge ledger the agent reads, `now()` the clock its acceptance records, and `AgentError` the agent's
 * error class `(code, message, status)`, so that refusals keep the codes the HTTP routes know.
 */
export function withFirstAdmission(agent, ledger, now, AgentError) {
  const refusal = (code, status, message) => new AgentError(code, message, status);
  // The agent's codes for a ledger answer, with the ledger's own code in the message.
  function ledgerRefusal({ code, status, cause }) {
    const detail = `${code}${cause ? ` (${cause})` : ''}`;
    if (code === 'seller_job_bound') return refusal('job_taken', 409, 'this job is bound to another buyer or bundle');
    if (status === 503) return refusal('session_admission_unavailable', 503, `the seller session admission is unavailable: ${detail}`);
    return refusal('session_not_admitted', 409, `the presentation challenge is refused: ${detail}`);
  }
  async function admitFirst({ transportIdentity, buyerIdentityBundle: bundle }) {
    const jobId = transportIdentity?.jobId, nonce = bundle?.sessionNonce, issued = typeof nonce === 'string' ? ledger.retained(nonce) : null;
    // A presentation that names no issued challenge consumes none, and the agent refuses it as a job with no accepted presentation.
    if (issued === null || ledger.jobBinding(jobId) !== null) return;
    let presentationHash = null;
    try { presentationHash = sha256Hex(canonicalize(bundle)); } catch { /* a malformed attempt still consumes its challenge */ }
    const answer = ledger.attempt({ path: 'context', nonce, jobId, buyer: bundle?.presentedBy, challengeScopeHash: issued.challengeScopeHash, presentationHash });
    if (answer.kind === 'refused') throw ledgerRefusal(answer);
    if (answer.kind !== 'validate') return;
    try {
      const admission = await agent.admitSessionPresentation({ jobId, bundle, nonce });
      const checkedAt = now();
      const record = { buyerBundleText: canonicalize(bundle), buyerBundleHash: identityBundleHash(bundle), admission: structuredClone(admission), admittedAt: checkedAt,
        firstAdmission: { challengeExpiresAt: issued.expiresAt, generatedAt: checkedAt, checkedAt } };
      if (!ledger.accept(answer.owner, nonce, record)) throw refusal('session_not_admitted', 409, 'the presentation challenge no longer belongs to this attempt');
    } catch (error) {
      try { ledger.recordFailed(answer.owner, nonce, typeof error?.code === 'string' && error.code ? error.code : 'operation_uncertain'); } catch { /* the next start closes the attempt */ }
      throw error?.code === 'seller_job_bound' ? ledgerRefusal(error) : error;
    }
  }
  return { ...agent, async receiveProposal(request, options) { await admitFirst(request); return agent.receiveProposal(request, options); } };
}
