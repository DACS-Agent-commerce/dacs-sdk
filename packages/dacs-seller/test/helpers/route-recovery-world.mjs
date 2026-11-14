// Worlds for the per-route recovery tests: the wire handler over the real durable agent of a committed job.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseSync from 'better-sqlite3';
import { sha256Hex } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_PATHS as PATHS, inspectWireOperation } from '@kynesyslabs/dacs/wire';
import { createSellerAgent } from '../../src/dacs/seller-agent.mjs';
import { createSellerDurableState } from '../../src/dacs/seller-durable-state.mjs';
import { listingPin } from '../../src/dacs/purchase-protocol.mjs';
import { fixtureListing } from '../fixtures/listings.mjs';
import { JOB, NOW, buyer, seller } from './protocol-fixture.mjs';
import { fixtureProposal } from './seller-agent-isolated-fixture.mjs';
import { localAnchor } from './local-anchor-fixture.mjs';
import { SELLER, continuingWorld, world } from './wire-routes-world.mjs';
import { wireContinuationFixture } from './wire-continuation-fixture.mjs';

export const SHORT_LEASE_MS = 1000;
/** Each bundle route × payment present: the refusal it names, and its status. */
export const BUNDLE_REFUSALS = [[PATHS.bundleRequest, false, 'not_delivered', 422], [PATHS.bundleRequest, true, 'bundle_finalization_unavailable', 503],
  [PATHS.bundleCountersignature, false, 'bundle_finalization_unavailable', 503], [PATHS.bundleCountersignature, true, 'bundle_finalization_unavailable', 503]];

export const operationOf = (w, jobId, path) => inspectWireOperation(w.handle.wire.journal, { seller: SELLER.claim, jobId, path });
/** The completions the completion port recorded: only a final outcome is recorded, and only it returns a route slot. */
export const completions = (w) => {
  const db = new DatabaseSync(w.storePath, { readonly: true });
  try { return db.prepare('SELECT route, attempt, status, cleanup FROM kit_ordinary_completions ORDER BY rowid').all(); } finally { db.close(); }
};

/** Marks a retained session as paid and delivered, with its settlement bound to the job (`state` is the durable state `editSession` opened). */
export const markPaid = (session, state) => {
  session.payment = { settlementId: 'demos:one', txHash: 'a'.repeat(64), deliveredAt: NOW };
  session.stage = 'delivered';
  state.bindSettlement('demos:one', session.jobId, { jobId: session.jobId, phaseIndex: 2 });
};

/** Rewrites one retained session of the real agent behind `fixture` while the agent is closed, then reopens the agent. */
export async function editSession(fixture, jobId, change) {
  fixture.agent().close();
  const state = await createSellerDurableState({ dir: fixture.dir, signer: { ...seller, sign: seller.signBytes }, listingPin: listingPin(fixture.listing) });
  await state.withJob(jobId, (session) => { change(session, state); state.saveSession(session); });
  state.close();
  await fixture.reopen();
}

/** A seller whose handler runs the real durable agent over a committed job; the stand-in keeps the host's retained-Agreement bookkeeping. */
export async function realWorld(t, options) {
  const fixture = await wireContinuationFixture(t), w = await world(t, { fixture, ...options });
  const real = () => fixture.agent(), calls = { receive: 0 };
  Object.assign(w.agent, {
    receiveProposal: (body, settings) => { calls.receive++; return real().receiveProposal(body, settings); },
    reconcileTransport: (input) => real().reconcileTransport(input),
    retainsProposalWork: (id) => real().retainsProposalWork(id),
    retainsUnfinishedWork: (target) => real().retainsUnfinishedWork(target),
    revalidateCompletedAnswer: (input) => real().revalidateCompletedAnswer(input),
  });
  const jobId = fixture.agreement.jobId, agreementHash = fixture.request.transportIdentity.agreementHash;
  const request = (path, settings = {}) => w.post(path, path === PATHS.proposals ? fixture.request : { jobId }, { jobId, agreementHash, ...settings });
  return { ...w, fixture, calls, jobId, agreementHash, request };
}

/** A private directory for a seller's data, removed after the test: `{ directory, data }`. */
export const tempDirectory = (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-signature-cut-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const data = join(directory, 'data');
  mkdirSync(data, { mode: 0o700 });
  return { directory, data };
};

/**
 * A durable fixture-profile seller on `directory` and its proposal body for `JOB`. Its signer logs each Agreement signature it makes in
 * `signatures`; `failNextSignature()` makes its next call throw before anything is signed.
 */
export async function proposalSigningRig(directory) {
  const listing = fixtureListing(seller, { now: NOW }), signatures = [];
  const { body } = await fixtureProposal(listing, JOB);
  const agreementBytes = Buffer.from(body.proposal.plan.signedBytes).toString();
  let failures = 0;
  // The signer also authenticates the durable state; only the Agreement signature is logged.
  const signer = { claim: seller.claim, sign: (bytes) => {
    if (failures > 0) { failures--; throw new Error('TEST signer failure'); }
    if (Buffer.from(bytes).toString() === agreementBytes) signatures.push(sha256Hex(bytes));
    return seller.signBytes(bytes);
  } };
  const agent = await createSellerAgent({ signer, listing, anchors: localAnchor({ now: () => NOW + 2000 }), durableDirectory: directory, now: () => NOW + 2000, simulatedFixture: true });
  return { agent, body, signatures, failNextSignature: () => { failures = 1; } };
}

/** The input of the agent's `reconcileTransport` for the proposal `body` of `JOB`, and a transport that claims it live. */
export const reconcileInput = (agent, body) => {
  const rawBody = Buffer.from(JSON.stringify(body));
  return { body, rawBody, request: { method: 'POST', path: PATHS.proposals, jobId: JOB, buyer: buyer.claim, seller: seller.claim, listingPin: agent.listingPin,
    agreementHash: body.transportIdentity.agreementHash, bodyHash: sha256Hex(rawBody) } };
};
export const claimedTransport = { claim: () => ({ live: true, check() {} }), settle() {} };

/** The real agent behind the bundle routes of a committed job. */
export async function bundleWorld(t, options) {
  const w = await continuingWorld(t, options), real = () => w.fixture.agent();
  Object.assign(w.agent, {
    bundleRequest: (body, settings) => real().bundleRequest(body, settings),
    countersign: (body, settings) => real().countersign(body, settings),
    reconcileTransport: (input) => real().reconcileTransport(input),
    retainsUnfinishedWork: (target) => real().retainsUnfinishedWork(target),
  });
  return w;
}
