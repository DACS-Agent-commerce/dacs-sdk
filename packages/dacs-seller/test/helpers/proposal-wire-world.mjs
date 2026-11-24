// The wire handler over the real durable agent of the proposal-admission fixture, before any proposal is admitted.
import { PATHS, world } from './wire-routes-world.mjs';
import { FIXTURE_ENDPOINT } from './wire-buyer.mjs';
import { proposalAdmissionFixture } from './proposal-admission-fixture.mjs';
import { createDemDeliveryContext } from '../../src/dacs/dem-delivery-context-consumer.mjs';
import { JOB } from './protocol-fixture.mjs';
import { SHORT_LEASE_MS } from './route-recovery-world.mjs';

export const AGREEMENT_SIGNATURE_PREFIX = 'dacs-payee-bound-agreement:v1:';
/** Context session states that end a purchase, so that the agent signs nothing more for it. */
export const ENDED_SESSIONS = ['aborted-by-other', 'vet-failed'];

/** The awaited steps of the agent's proposal work before it signs. */
export const SIGNING_BOUNDARIES = ['resolveVetRecord', 'readVetAnchorReceipt', 'verifyVetAnchorReceipt', 'context'];

/** A `configure` that ends the session as `terminal` right after the step `boundary` of the agent's work (or after its Agreement signature). */
export const endSessionAfter = (boundary, terminal) => (f, endSession) => {
  if (boundary === 'context') {
    f.config.demDeliveryContext = createDemDeliveryContext({ authority: 'TEST-terminal-context', resolveBuyer: async () => null, resolveSeller: async ({ jobId }) => {
      endSession(terminal);
      return { disposition: 'present', value: structuredClone(f.contexts.get(jobId)) };
    } });
  } else if (boundary === 'signature') {
    const sign = f.config.signer.sign;
    f.config.signer.sign = (bytes) => {
      const signature = sign(bytes);
      if (Buffer.from(bytes).toString().startsWith(AGREEMENT_SIGNATURE_PREFIX)) endSession(terminal);
      return signature;
    };
  } else {
    const read = f.admission.sessionAdmission[boundary];
    f.admission.sessionAdmission[boundary] = async (...args) => {
      const value = await read(...args);
      endSession(terminal);
      return value;
    };
  }
};

/**
 * `configure(f, endSession)` runs before the agent opens, to wrap one of the awaited steps of its proposal work; `endSession(state)` ends
 * the context session the wire's store reads. `arm()` makes a wrapped step end the session the next time it runs. `restart()` closes the
 * agent and opens it again on the same directory, with the fixture's configuration as it is then.
 */
export async function proposalWireWorld(t, { configure = () => {}, leaseMs = SHORT_LEASE_MS, ...options } = {}) {
  const f = await proposalAdmissionFixture(t, { assembled: true, publicEndpoint: FIXTURE_ENDPOINT });
  let w;
  const armed = { value: false };
  const endSession = (state) => { if (armed.value) { armed.value = false; w.state.session = state; } };
  configure(f, endSession);
  let agent = await f.open();
  const body = await f.proposal(agent);
  w = await world(t, { fixture: { listing: f.listing, agent: () => agent }, leaseMs, ...options });
  Object.assign(w.agent, {
    receiveProposal: (input, settings) => agent.receiveProposal(input, settings),
    agreementState: (identity) => agent.agreementState(identity),
    reconcileTransport: (input) => agent.reconcileTransport(input),
    retainsProposalWork: (id) => agent.retainsProposalWork(id),
    retainsUnfinishedWork: (target) => agent.retainsUnfinishedWork(target),
    transportAgreementOf: (id) => agent.transportAgreementOf(id),
  });
  const agreementSignatures = () => f.signed.filter((value) => value.startsWith(AGREEMENT_SIGNATURE_PREFIX)).length;
  const post = (settings = {}) => w.post(PATHS.proposals, body, { jobId: JOB, agreementHash: body.transportIdentity.agreementHash, ...settings });
  const restart = async () => { agent.close(); agent = await f.open(); };
  return { ...w, f, realAgent: () => agent, body, jobId: JOB, post, agreementSignatures, restart, arm: () => { armed.value = true; } };
}
