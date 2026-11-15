// A fixture-profile seller behind the wire handler: the real durable agent over fixture anchors and a scripted transfer observer, mounted on
// the wire journal by the same world the other wire tests use. Nothing prefills a payment: grants, signatures, CREATEs and deliveries come from
// the agent's own run and are counted here.
import assert from 'node:assert/strict';
import { ARTIFACT_SEPARATORS, paymentEvidenceAddress } from '@kynesyslabs/dacs';
import { agentFixture, fixtureProposal } from './seller-agent-isolated-fixture.mjs';
import { JOBS } from './bilateral-vet-fixture.mjs';
import { NOW, buyer, seller } from './protocol-fixture.mjs';
import { observeConfirmedNativeTransfer } from './confirmed-native-transfer-fixture.mjs';
import { PATHS, derive, world } from './wire-routes-world.mjs';
import { deliverableAddress, deliveryEvidenceAddress } from '../../src/dacs/purchase-protocol.mjs';

export const PAYMENT_LEASE_MS = 1000;
export const PAYMENT_TX = derive('fixture-payment-transaction').toLowerCase();
export const OTHER_TX = derive('fixture-payment-corrected-transaction').toLowerCase();
const PRICE_OS = '2500000000';
const SELLER_ENDPOINT = 'https://seller.example.invalid';
/** The text of the message the seller signs for any settlement evidence (the payment's and the delivery's), for `script.signFault`. */
export const EVIDENCE_SIGNATURE = ARTIFACT_SEPARATORS.SettlementEvidence;
/** The text a session save carries once the payment work is retained, for `script.signFault`. */
export const WORK_SAVE_SIGNATURE = '"paymentWork"';

/** The transfer the fixture node reports for `txHash` unless a test scripts another answer. */
export const includedTransfer = (txHash, { payer = buyer.address, amountOs = PRICE_OS } = {}) =>
  observeConfirmedNativeTransfer({ txHash, payer, payee: seller.address, amountOs, blockNumber: 8, includedAt: NOW + 3000 });

// The wire accepts a commitment only with a receipt of the approved chain. The fixture anchor's receipt is the same record in the chain's shape,
// which the wire's receipt reader (always valid here) then accepts; the agent itself keeps and verifies its own fixture receipt.
const wireCommitmentText = (text) => {
  const commitment = JSON.parse(text), receipt = commitment.anchorReceipt;
  return JSON.stringify({ ...commitment, anchorReceipt: { ...receipt, substrate: 'demos', finalityProfile: 'TEST-wire', transactionRef: { kind: 'demos', value: receipt.transactionRef.value },
    evidence: { kind: 'TEST-source', value: 'fixture' }, nonce: '1' } });
};

/**
 * One fixture-profile seller with two negotiated jobs: `jobId` and `otherJobId`. Returns the wire world plus
 * `pay({ id, txHash, ...settings })` (a signed payment request), `lapse()` (the open attempt's lease ends), `restart()` (the agent and the
 * wire reopen over the same directories), `script` (`observe(txHash)` answers the transfer reads when set; `signFault` makes the signer throw
 * once for a message that includes it) and the counters of what the agent really did.
 */
export async function fixturePaymentWorld(t, { leaseMs = PAYMENT_LEASE_MS, ...worldOptions } = {}) {
  const f = await agentFixture({ publicEndpoint: SELLER_ENDPOINT });
  t.after(() => f.close());
  const [jobId, otherJobId] = JOBS;
  const script = { observe: null, signFault: null };
  const counts = { observations: [], signed: [], publicSubmits: 0 };
  const observeAt = f.config.observeDemosTransfer;
  f.config.observeDemosTransfer = async (txHash, limits) => {
    counts.observations.push(txHash);
    return script.observe ? script.observe(txHash) : observeAt(txHash, limits);
  };
  f.config.signer = { ...f.config.signer, sign: (bytes) => {
    const text = Buffer.from(bytes).toString('utf8');
    counts.signed.push(text);
    if (script.signFault !== null && text.includes(script.signFault)) { script.signFault = null; throw new Error('TEST evidence signer failure'); }
    return seller.signBytes(bytes);
  } };
  await f.reopen();
  const real = () => f.agent, admitted = new Set();
  const continuationEvidenceOf = (id) => { const texts = real().continuationEvidenceOf(id); return texts && { ...texts, commitmentText: wireCommitmentText(texts.commitmentText) }; };
  // The host holds a job from the proposal its wire route admitted, which is when the transport store keeps the job's tuple.
  const transportAgreementOf = (id) => (admitted.has(id) ? real().transportAgreementOf(id) : null);
  const w = await world(t, { fixture: { listing: f.listing, agent: () => ({ transportAgreementOf, continuationEvidenceOf }) }, leaseMs, ...worldOptions });
  Object.assign(w.agent, {
    claim: seller.claim,
    transportAgreementOf,
    continuationEvidenceOf,
    receiveProposal: (body, settings) => real().receiveProposal(body, settings),
    reconcileTransport: (input) => real().reconcileTransport(input),
    retainsProposalWork: (id) => real().retainsProposalWork(id),
    retainsUnfinishedWork: (target) => real().retainsUnfinishedWork(target),
    retainsPaymentClaim: (id, body) => real().retainsPaymentClaim(id, body),
    retainsPaymentWork: (id) => real().retainsPaymentWork(id),
    revalidateCompletedAnswer: (input) => real().revalidateCompletedAnswer(input),
    assertSettlementCredit: (id) => real().assertSettlementCredit(id),
    submitPayment: (body, settings) => { counts.publicSubmits++; return real().submitPayment(body, settings); },
    commit: (body, settings) => real().commit(body, settings),
  });
  const agreementHashes = new Map();
  for (const id of [jobId, otherJobId]) {
    const { body } = await fixtureProposal(f.listing, id);
    agreementHashes.set(id, body.transportIdentity.agreementHash);
    const answer = await w.post(PATHS.proposals, body, { jobId: id, agreementHash: agreementHashes.get(id) });
    assert.equal(answer.status, 200, `the proposal of ${id} is admitted on the wire: ${answer.text}`);
    admitted.add(id);
    assert.equal((await f.agent.commit({ jobId: id })).status, 'committed');
  }
  const bodyOf = (id, txHash) => ({ jobId: id, txHash, payerPayingKey: buyer.claim });
  const pay = ({ id = jobId, txHash = PAYMENT_TX, ...settings } = {}) => w.post(PATHS.payments, bodyOf(id, txHash), { jobId: id, agreementHash: agreementHashes.get(id), ...settings });
  const writesAt = (address) => f.anchors.writes.filter((written) => written === address).length;
  return { ...w, f, jobId, otherJobId, script, counts, pay, bodyOf, agreementHashes,
    lapse: () => { w.state.time += leaseMs; },
    restart: async () => { await f.reopen(); w.reopen(); },
    evidenceCreates: (id = jobId) => writesAt(paymentEvidenceAddress(id, 'demos-native:DEM', 2)),
    deliverableWrites: (id = jobId) => writesAt(deliverableAddress(id)),
    deliveryEvidenceWrites: (id = jobId) => writesAt(deliveryEvidenceAddress(id)),
    evidenceSignatures: () => counts.signed.filter((text) => text.startsWith(EVIDENCE_SIGNATURE)).length,
    work: (id = jobId) => f.agent.durableSessionOf(id)?.paymentWork,
    payment: (id = jobId) => f.agent.durableSessionOf(id)?.payment };
}
