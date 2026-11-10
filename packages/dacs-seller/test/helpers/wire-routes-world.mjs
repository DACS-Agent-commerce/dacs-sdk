// The seller handler on its own wire journal with a counting stand-in agent, and the buyer that signs for it.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseSync from 'better-sqlite3';
import { canonicalize, compositeVerificationAddress, sha256Hex } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_PATHS, WireError, admitWireArtifact, inspectWireOperation, openWireRequestJournal } from '@kynesyslabs/dacs/wire';
import { fixtureIdentityBundle, fixtureListing } from '../fixtures/listings.mjs';
import { exchange } from './d5-http-fixture.mjs';
import { proposalForInput } from './proposal-admission-fixture.mjs';
import { NOW, buyer, seller, testWallet } from './protocol-fixture.mjs';
import { TEST_CONNECTION, authorityReader } from './wire-authority-fixture.mjs';
import { wireBuyer } from './wire-buyer.mjs';
import { agreementInput, listingPin } from '../../src/dacs/purchase-protocol.mjs';
import { createOrdinaryCompletionPort, createSellerHttpHandler } from '../../src/dacs/seller-http.mjs';
import { createPurchaseCapacity } from '../../src/dacs/seller-purchase-capacity.mjs';
import { createReservationCoordinator } from '../../src/dacs/seller-reservation-accounting.mjs';
import * as wireRequests from '../../src/dacs/seller-wire-requests.mjs';
import { wireContinuationFixture, receiptReader } from './wire-continuation-fixture.mjs';
import { retainedFor } from '../../src/dacs/seller-wire-requests.mjs';
import { SELLER_TRANSPORT_HEADER, createSellerTransportServerAuth, createSellerTransportStore as createUnboundStore, sellerStoreInternals } from '../../src/dacs/seller-transport-auth.mjs';
import { createSellerTransportStore } from './bound-transport-store.mjs';

export const PATHS = DACS_SELLER_HTTP_PATHS;
export const CONTINUING = [PATHS.payments, PATHS.bundleRequest, PATHS.bundleCountersignature];
export const BUYER = { claim: buyer.claim, sign: buyer.signBytes };
export const SELLER = { claim: seller.claim, sign: seller.signBytes };
export const session = testWallet(3);
export const SESSION = { claim: session.claim, sign: session.signBytes };
export const LISTING = fixtureListing(seller, { now: NOW });
export const PIN = listingPin(LISTING);
export const CLAIM_PREFIX = 'did:demos:agent:';
export const MAX_RESPONSE_BYTES = 512 * 1024;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_HEADER_CHARS = 4096;
export const MAX_REQUEST_LIFETIME_MS = 60_000;
export const MAX_SIGNED_LIFETIME_MS = 30_000;
export const SKEW_MS = 30_000;
export const DAY_MS = 86_400_000;
export const REQUEST_NONCE_BYTE = 0x6e;
export const JOURNAL_LEASE_MS = 300_000;
export const OLD_PIN_VERSION = 'dacs-demos-testnet-identity/2026-10-15';

export const derive = (label) => sha256Hex(`wire-signed-routes:${label}`);
export const jobFor = (label) => `0${derive(`job-${label}`).slice(0, 25).toUpperCase()}`;
export const publicKeyHex = (wallet) => wallet.claim.slice(CLAIM_PREFIX.length);
let nonceCounter = 0;
export const nextNonce = () => Buffer.alloc(24, (REQUEST_NONCE_BYTE + ++nonceCounter) % 256).toString('base64url');
export const vetRef = (jobId, party) => ({ anchor: { kind: 'storage-program', locator: compositeVerificationAddress(jobId, party.claim) }, contentHash: derive(`vet:${jobId}:${party.claim}`), signer: seller.claim });
export const MUTATING = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|BEGIN)/i;

/** A valid proposals body for `jobId`, with the Agreement hash and deadline its draft names. */
export async function proposalFor(jobId, generatedAt = NOW) {
  const base = agreementInput({ jobId, listing: LISTING, buyerBundle: fixtureIdentityBundle(buyer, NOW), generatedAt });
  const input = { ...base, buyer: { ...base.buyer, vetRecordRef: vetRef(jobId, buyer) }, seller: { ...base.seller, vetRecordRef: vetRef(jobId, seller) } };
  const body = await proposalForInput(input);
  return { body, agreementHash: body.transportIdentity.agreementHash, deadline: body.proposal.plan.draft.terms.deadline };
}
export const identityBody = (jobId, agreementHash) => ({ transportIdentity: { jobId, buyer: buyer.claim, seller: seller.claim, agreementHash } });

/** The statements the store's database ran while `work` ran. */
export async function statementsDuring(work) {
  const { prepare, exec } = DatabaseSync.prototype;
  const seen = [];
  DatabaseSync.prototype.prepare = function recordPrepare(sql) { seen.push(sql); return prepare.call(this, sql); };
  DatabaseSync.prototype.exec = function recordExec(sql) { seen.push(sql); return exec.call(this, sql); };
  try { await work(); } finally { Object.assign(DatabaseSync.prototype, { prepare, exec }); }
  return seen;
}

/** A counting stand-in for the seller agent: it retains each proposal's draft, as the real agent's session does. */
export function stubAgent() {
  const drafts = new Map();
  const agent = {
    claim: seller.claim, listingPin: PIN, retains: false, credit: () => {}, onWork: () => {}, answer: undefined,
    calls: { proposals: 0, commits: 0, states: 0, reconciled: 0, payments: 0 },
    transportAgreementOf: (jobId) => structuredClone(drafts.get(jobId) ?? null),
    retainsProposalWork: (jobId) => agent.retains && drafts.has(jobId),
    retainsPaymentClaim: () => agent.retains,
    assertSettlementCredit: (jobId) => agent.credit(jobId),
    receiveProposal: async (body, { transport } = {}) => {
      agent.calls.proposals++;
      agent.onWork('proposal', body);
      transport?.check();
      drafts.set(body.transportIdentity.jobId, body.proposal.plan.draft);
      return agent.answer ? agent.answer() : { disposition: 'complete', contribution: { signed: true } };
    },
    commit: async (body) => { agent.calls.commits++; agent.onWork('commit', body); return agent.answer ? agent.answer() : { status: 'committed', jobId: body.jobId }; },
    readCommitment: async ({ jobId }) => { agent.onWork('commit-read'); return { status: 'committed', jobId }; },
    agreementState: (identity) => { agent.calls.states++; return { proposal: null, contribution: null, jobId: identity.jobId }; },
    submitPayment: async () => { agent.calls.payments++; agent.onWork('payment'); return { status: 'payment-evidenced', delivery: { status: 'delivered' } }; },
    reconcileTransport: async ({ request, transport }) => {
      agent.calls.reconciled++;
      transport.claim();
      await transport.settle({ disposition: 'present', status: 200, value: request.path === PATHS.proposals ? { disposition: 'complete', contribution: { signed: true } } : { status: 'committed', jobId: request.jobId }, settle: true });
    },
  };
  return agent;
}

/** One seller: a transport store, a bound profile, the wire journal and the handler, with a buyer that signs for it. */
export async function world(t, { maxJobs, maxRecords, readAuthority = authorityReader(), fixture = null, leaseMs = JOURNAL_LEASE_MS } = {}) {
  const pin = fixture ? listingPin(fixture.listing) : PIN;
  const directory = await mkdtemp(join(tmpdir(), 'TEST-wire-routes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'transport'), { mode: 0o700 });
  const storePath = join(directory, 'transport', 'transport.sqlite');
  const state = { time: NOW, ready: true, connection: { ...TEST_CONNECTION }, authorityReads: 0, withdrawAtRead: null, lapseAtRead: null, lapseMs: MAX_SIGNED_LIFETIME_MS + 1, elapsedMs: 0, readsAtReserve: 0, journals: [] };
  // The wire measures the time an admission takes with `performance.now`: the test moves it forward by `elapsedMs`.
  const monotonicNow = performance.now.bind(performance);
  mock.method(performance, 'now', () => monotonicNow() + state.elapsedMs);
  t.after(() => mock.restoreAll());
  const clock = () => state.time;
  const connection = () => ({ ...state.connection });
  const signing = { calls: 0, failures: 0 };
  const sellerSigner = { claim: seller.claim, sign: (bytes) => {
    signing.calls++;
    if (signing.failures > 0) { signing.failures--; throw new Error('TEST signer failure'); }
    return seller.signBytes(bytes);
  } };
  const reader = (scope) => {
    state.authorityReads++;
    if (state.withdrawAtRead === state.authorityReads) throw new WireError('tp1_participant_refused', 503, undefined, new Error('TEST authority withdrawn'));
    if (state.lapseAtRead === state.authorityReads) state.elapsedMs += state.lapseMs;
    return readAuthority(scope);
  };
  const buyerWire = await wireBuyer({ buyer: BUYER, seller: SELLER, listingPin: pin, clock, connection, readAuthority: reader,
    readCommitmentReceipt: receiptReader(), publicEndpoint: fixture?.listing.seller.publicEndpoint,
    evidenceFor: async (path, id) => fixture && [...CONTINUING, PATHS.bundleBuyerCopy].includes(path) ? {
      commitment: Buffer.from(fixture.agent().continuationEvidenceOf(id).commitmentText),
      agreement: Buffer.from(fixture.agent().continuationEvidenceOf(id).agreementText), signedListing: Buffer.from(JSON.stringify(fixture.listing)),
    } : {} });
  const agent = stubAgent();
  agent.listingPin = pin;
  agent.bundleRequest = async () => { agent.calls.bundles++; agent.onWork('bundle'); return { status: 'held' }; };
  agent.countersign = agent.bundleRequest;
  agent.confirmBuyerCopy = async () => ({ status: 'held' });
  agent.commitOnSignature = agent.commit;
  agent.calls.bundles = 0;
  if (fixture) {
    agent.transportAgreementOf = (jobId) => fixture.agent().transportAgreementOf(jobId);
    agent.continuationEvidenceOf = (jobId) => fixture.agent().continuationEvidenceOf(jobId);
  }
  const handle = { store: null, handler: null, finishFails: false };
  const mount = () => {
    if (fixture) fixture.admittedListing = admitWireArtifact(Buffer.from(JSON.stringify(fixture.listing)));
    const store = createUnboundStore({ path: storePath, maxJobs, maxRecords, now: clock });
    const capacity = createPurchaseCapacity({ store, now: clock, maxRecords, sessionState: sellerStoreInternals(store).sessionState });
    // A restart reopens the same journal.
    const journalDirectory = join(directory, 'wire-journal');
    if (state.journals.length === 0) { mkdirSync(journalDirectory, { mode: 0o700 }); state.journals.push(journalDirectory); }
    const journal = openWireRequestJournal(journalDirectory, { leaseMs, clock });
    const authentication = createSellerTransportServerAuth({ sellerSigner: { claim: seller.claim, sign: seller.signBytes }, listingPin: pin, store, now: clock });
    const reservations = createReservationCoordinator({ accounting: store.reservationAccounting, capacity, inspectOperation: (target) => inspectWireOperation(journal, target) });
    // The journal's reservation re-checks authority with one more read, right after the coordinator is entered.
    const reserveCoordinated = reservations.reserveCoordinated.bind(reservations);
    reservations.reserveCoordinated = (...args) => { state.readsAtReserve = state.authorityReads + 1; return reserveCoordinated(...args); };
    const completion = createOrdinaryCompletionPort({ journal, store, capacity });
    const wire = { binding: buyerWire.binding, connection, signer: sellerSigner, journal, store, reservations, completion, ready: () => state.ready, now: clock, requireDelegation: false,
      retainedFor: (input) => retainedFor(agent, input),
      continuationFor: (input) => fixture ? wireRequests.continuationFor(agent, input, fixture.admittedListing ?? fixture.listing) : {},
      readCommitmentReceipt: fixture?.readCommitmentReceipt ?? receiptReader() };
    Object.assign(handle, { store, capacity, wire, handler: createSellerHttpHandler(agent, { authentication, wire, commitOnSignature: true }) });
  };
  mount();
  t.after(() => handle.store.close());
  const reopen = () => { handle.store.close(); handle.finishFails = false; mount(); };
  const answerOf = (res, payload) => ({ status: res.status, text: res.text, body: JSON.parse(res.text), header: res.headers?.[SELLER_TRANSPORT_HEADER], signed: res.headers?.[SELLER_TRANSPORT_HEADER] !== undefined, payload });
  const send = async (path, { text, header, payload = null }) => answerOf(await exchange(handle.handler, { url: path, text, header }), payload);
  /** A request the buyer's `signWireRequest` signs, sent through the handler. */
  const post = async (path, body, { jobId, agreementHash, ...options } = {}) => {
    const signed = await buyerWire.signRequest(path, body, { jobId, agreementHash, ...options });
    return send(path, signed);
  };
  const verified = (answer) => buyerWire.authentication(() => null).verifyResponse(answer.payload, { header: answer.header, status: answer.status, responseBytes: Buffer.from(answer.text) });
  const rows = () => {
    const db = new DatabaseSync(storePath, { readonly: true });
    try { return Object.fromEntries(['peer_effects', 'peer_nonces', 'peer_jobs', 'peer_slots', 'kit_purchase_profiles'].map((name) => [name, db.prepare(`SELECT count(*) AS n FROM ${name}`).get().n])); } finally { db.close(); }
  };
  const journalFiles = () => state.journals.flatMap((directoryPath) => readdirSync(directoryPath));
  const effects = (counter = agent.calls) => Object.values(counter).reduce((sum, n) => sum + n, 0);
  /** A hand-built request header, signed as `signer` under `domain`: payloads the wire's own signer refuses to make. */
  const payloadFor = (path, text, { jobId, agreementHash, expiresAt = NOW + MAX_SIGNED_LIFETIME_MS, buyerClaim = buyer.claim, ...rest }) => ({ version: '1', kind: 'request', method: 'POST', path, bodyHash: sha256Hex(text),
    jobId, buyer: buyerClaim, seller: seller.claim, listingPin: pin, agreementHash, nonce: nextNonce(), expiresAt, profile: buyerWire.binding.profile, ...rest });
  const headerFor = (payload, { signer = BUYER, domain = DACS_SELLER_HTTP_DOMAINS.request, delegation } = {}) => Buffer.from(canonicalize({ payload,
    signature: signer.sign(Buffer.from(domain + canonicalize(payload))).toString('base64url'), ...(delegation ? { delegation } : {}) })).toString('base64url');
  const delegationFor = ({ jobId, expiresAt, domain = DACS_SELLER_HTTP_DOMAINS.delegation, ...rest }) => {
    const payload = { version: '1', kind: 'seller-session-delegation', buyer: buyer.claim, seller: seller.claim, sessionPublicKey: publicKeyHex(session), listingPin: pin, jobId,
      notBefore: NOW - SKEW_MS, expiresAt, profile: buyerWire.binding.profile, ...rest };
    return { payload, signature: BUYER.sign(Buffer.from(domain + canonicalize(payload))).toString('base64url') };
  };
  return { directory, leaseMs, state, agent, signing, buyerWire, handle, mount, reopen, post, send, verified, rows, journalFiles, effects, payloadFor, headerFor, delegationFor, storePath, clock };
}

export const proposeJob = async (w, label) => {
  const jobId = jobFor(label), proposal = await proposalFor(jobId);
  return { jobId, ...proposal, post: (options) => w.post(PATHS.proposals, proposal.body, { jobId, agreementHash: proposal.agreementHash, ...options }) };
};

/** A world over a real durable agent's retained commitment, with its proposal completed. */
export async function continuingWorld(t) {
  const fixture = await wireContinuationFixture(t), w = await world(t, { fixture });
  const jobId = fixture.agreement.jobId, agreementHash = fixture.request.transportIdentity.agreementHash;
  const bodyFor = (path) => path === PATHS.proposals ? fixture.request : path === PATHS.state ? identityBody(jobId, agreementHash)
    : path === PATHS.payments ? { jobId, txHash: derive('continuing-payment'), payerPayingKey: buyer.claim }
      : path === PATHS.commitmentSignature ? { jobId, agreement: fixture.agreement, signedProjection: {} } : { jobId };
  const post = (path, options = {}) => w.post(path, bodyFor(path), { jobId, agreementHash, ...options });
  assert.equal((await post(PATHS.proposals)).status, 200);
  return { ...w, fixture, jobId, agreementHash, bodyFor, request: post };
}
