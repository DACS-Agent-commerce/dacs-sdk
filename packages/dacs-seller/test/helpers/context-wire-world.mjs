// Unshipped fixture for the context route on the wire: the challenge fixture's HTTP handler, wire context and transport store,
// composed with the real admission transaction, purchase capacity, reservation coordinator and wire journal, a counting policy
// and a stand-in provider behind the real registered capability. Requests are signed through the wire's buyer; `startContext`
// issues a challenge over HTTP and builds the matching presentation.
import { createHash } from 'node:crypto';
import { canonicalize, identityBundleHash, sha256Hex } from '@kynesyslabs/dacs';
import { completeWireEffect, inspectWireOperation, wireOperationId } from '@kynesyslabs/dacs/wire';
import { createDemDeliveryContext, demDeliveryContextHost } from '../../src/dacs/dem-delivery-context-consumer.mjs';
import { createWireSellerContextRoute } from '../../src/dacs/seller-context-route.mjs';
import { createContextAdmissionTransaction } from '../../src/dacs/seller-admission-transaction.mjs';
import { createSellerHttpHandler } from '../../src/dacs/seller-http.mjs';
import { createReservationCoordinator } from '../../src/dacs/seller-reservation-accounting.mjs';
import { SELLER_CONTEXT_PATH, SELLER_TRANSPORT_HEADER, createSellerTransportServerAuth, sellerContextChallengeScope, sellerContextScopeHash, sellerStoreInternals } from '../../src/dacs/seller-transport-auth.mjs';
import { exchange } from './d5-http-fixture.mjs';
import { CHALLENGE_PATH, JOB, JOB2, T0, challengeWorld } from './challenge-route-fixture.mjs';
import { admittedSession } from './challenge-api.mjs';

export { JOB, JOB2, T0, SELLER_CONTEXT_PATH };
const POLICY_DEADLINE_MS = 10_000;
const hash = (text) => createHash('sha256').update(String(text)).digest('hex');
const vetRef = (tag) => ({ vetRecordRef: { anchor: { kind: 'storage-program', locator: `vet-${tag}` }, contentHash: hash(tag) } });
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

/** A presentation by `presenter` for `nonce`, signed over its identity hash. */
export function presentationFor(presenter, nonce, at) {
  const bundle = { bundleVersion: '1', presentedBy: presenter.claim, presentedAt: at, sessionNonce: nonce, claims: [{ ref: presenter.claim }] };
  return { ...bundle, presentation: { kind: 'per-claim', signatures: [{ ref: presenter.claim, signature: presenter.signBytes(Buffer.from(`dacs-bundle-presentation:v1:${identityBundleHash(bundle)}`)).toString('base64url') }] } };
}

export async function contextWireWorld(t, { requireDelegation = false, storeOptions = {}, resume = null } = {}) {
  const w = await challengeWorld(t, { requireDelegation, store: storeOptions, resume });
  const { state, calls, agent, buyer, seller, other } = w;
  const now = () => state.time;
  state.mono = 0;
  const counts = { validations: 0, holds: [], releases: [], resolves: 0, vetWrites: 0, agreementSignatures: 0, reserveAcquisitions: 0 };
  // What a test can bend: the presentation admission, the policy hold, the provider's steps and answer, the reservation (`recover` answers a recovery
  // effect the journal never issued), the wire completion (`nullEndFails`, `cutAfterPublish`, and `afterPublish`, run right after an outcome is published), the acceptance (`failAcceptance`) and the kind of effect evidence compensation reads (`evidenceKind`).
  const behaviour = { admit: null, policyReserve: null, provider: null, answer: null, afterFirstWrite: null, beforeReserve: null, recover: false, nullEndFails: false, cutAfterPublish: false, afterPublish: null, failAcceptance: false, evidenceKind: 'no-intent' };
  const fakeEffects = new Set(), completions = [];
  // A presentation's profile admission: the agent's own, here a counting stand-in that grants unless a test says otherwise.
  agent.admitSessionPresentation = async ({ jobId, bundle, nonce }) => {
    counts.validations++;
    if (behaviour.admit) await behaviour.admit({ jobId, bundle, nonce });
    return admittedSession({ jobId, bundle, bundleHash: identityBundleHash(bundle), seller: seller.claim, listingPin: w.pin });
  };
  const journal = w.wire.journal, capacity = w.store.boundCapacity;
  const policy = {
    reserve: async (request) => { counts.holds.push(request); return behaviour.policyReserve ? behaviour.policyReserve(request) : null; },
    release: async ({ jobId, hold }) => { counts.releases.push({ jobId, hold }); },
  };
  const operationOf = (jobId) => inspectWireOperation(journal, { seller: seller.claim, jobId, path: SELLER_CONTEXT_PATH });
  const completeWire = (effect, outcome) => {
    completions.push({ effect, outcome });
    if (outcome === null && behaviour.nullEndFails) throw new Error('TEST the null end was not published');
    if (fakeEffects.has(effect)) return;
    completeWireEffect(journal, effect, outcome);
    if (outcome !== null) behaviour.afterPublish?.();
    if (outcome !== null && behaviour.cutAfterPublish) throw new Error('TEST cut after the outcome was published');
  };
  const admission = createContextAdmissionTransaction({ store: w.store, policy, capacity,
    effectEvidence: async (row) => [row.vetAddresses.buyer, row.vetAddresses.seller].map((address) => ({ address, kind: behaviour.evidenceKind })),
    inspectContextOutcome: operationOf, completeWire, now, ready: () => state.ready(), deadlines: { policyMs: POLICY_DEADLINE_MS } });
  const coordinator = createReservationCoordinator({ accounting: w.store.reservationAccounting, capacity, inspectOperation: (target) => inspectWireOperation(journal, target), admissionTransaction: admission });
  const reserved = { calls: 0, ownerships: [] };
  const reserveCoordinated = coordinator.reserveCoordinated.bind(coordinator);
  coordinator.reserveCoordinated = async (input, ownership) => {
    reserved.calls++; reserved.ownerships.push(ownership);
    await behaviour.beforeReserve?.();
    if (!behaviour.recover) return reserveCoordinated(input, ownership);
    const effect = Object.freeze({ state: 'recover', operationId: wireOperationId(input.payload), attempt: 1, leaseUntil: now() + 300_000 });
    fakeEffects.add(effect);
    return effect;
  };
  const mutex = admission.jobEffectMutex.bind(admission);
  const acquisitions = [];
  const countingAdmission = Object.freeze({ ...admission, jobEffectMutex: (jobId) => {
    const inner = mutex(jobId);
    return Object.freeze({ acquire: () => { acquisitions.push(jobId); return inner.acquire(); }, run: (work) => { acquisitions.push(jobId); return inner.run(work); } });
  } });

  // The provider: two Vet writes, each asking the attempt's predicate first, as the real provider does before it signs.
  const sellerClaim = seller.claim;
  const presentAnswer = (input) => ({ disposition: 'present', value: { scope: structuredClone(input.scope), input: { jobId: input.scope.jobId, buyer: vetRef('buyer'), seller: vetRef('seller') } } });
  const resolveBuyer = async (input, options) => {
    counts.resolves++;
    if (behaviour.provider) await behaviour.provider(input, options);
    for (let write = 0; write < 2; write++) {
      if (options.writable() !== true) throw Object.assign(new Error('the purchase is no longer pending'), { code: 'not-pending' });
      counts.vetWrites++;
      if (write === 0 && behaviour.afterFirstWrite) await behaviour.afterFirstWrite(input, options);
    }
    return behaviour.answer ? behaviour.answer(input) : presentAnswer(input);
  };
  const capability = createDemDeliveryContext({ authority: 'TEST-context-wire', resolveSeller: async () => null, resolveBuyer, recoverBuyer: async () => null, resumableBuyer: async () => null,
    bindRetainedScope: () => ({ sellerBundlePresentedBy: sellerClaim }) });
  const provider = demDeliveryContextHost(capability);

  const tracked = new Set();
  const trackContextWork = (start) => {
    const task = start();
    tracked.add(task);
    void task.then(() => tracked.delete(task), () => tracked.delete(task));
    return task;
  };
  const drain = async () => { while (tracked.size > 0) await Promise.allSettled([...tracked]); };
  const wire = w.makeWire({ capacity, reservations: coordinator });
  const routeOptions = { listing: w.listing, wire, store: w.store, ledger: w.store.challenges, admissionTransaction: countingAdmission, coordinator, capacity, provider,
    assertBuyerAccess: async (claim) => { calls.access++; return w.policy.access(claim); }, knownJob: async (...input) => { calls.known++; return w.policy.known(...input); },
    ready: () => state.ready(), stopped: () => state.stop(), now, monotonicNow: () => state.mono, trackContextWork };
  const route = createWireSellerContextRoute(routeOptions);
  // After the route's own tuple hook, so a failure here rolls the stored tuple back with the rest of the acceptance.
  admission.addAcceptanceHook(() => { if (behaviour.failAcceptance) throw new Error('TEST the acceptance failed'); });
  const authentication = createSellerTransportServerAuth({ sellerSigner: { claim: seller.claim, sign: seller.signBytes }, listingPin: w.pin, store: w.store, now, requireDelegation });
  const handler = createSellerHttpHandler(agent, { authentication, context: { ...w.route, ...route }, wire });

  const post = async ({ url = SELLER_CONTEXT_PATH, header, text, chunks }) => {
    const res = await exchange(handler, { url, header, text, chunks });
    let body = null;
    try { body = JSON.parse(res.text); } catch { /* unsigned non-JSON answers */ }
    return { status: res.status, text: res.text, body, signature: res.headers?.[SELLER_TRANSPORT_HEADER] };
  };
  const issue = async ({ jobId = JOB, actor = buyer, delegation } = {}) => {
    const answer = await post({ url: CHALLENGE_PATH, ...(await w.sign({ jobId, actor, delegation })) });
    if (answer.status !== 200) throw new Error(`TEST the challenge was refused: ${answer.text}`);
    return answer.body.sessionNonce;
  };
  /**
   * A signed context request over a fresh challenge. `bundleChange(bundle)` alters the presentation before it is hashed and signed by
   * `presenter`; `scopeChange(scope)` alters the scope after its bundle hash is set; `bundleTamper(bundle)` and `bodyChange(body)` alter the
   * request after the presentation is signed; the envelope then hashes the final scope.
   */
  const startContext = async ({ jobId = JOB, actor = buyer, presenter = actor, bundleChange, scopeChange, bundleTamper, bodyChange, nonce, delegation, signOptions = {}, candidate = false } = {}) => {
    // A candidate scope is one the challenge route would refuse: its challenge is issued straight from the ledger, so that the attempt matches.
    const issueCandidate = () => {
      const scope = { ...w.scopeFor(jobId, actor), buyerBundleHash: '0'.repeat(64) };
      scopeChange?.(scope);
      return w.store.challenges.issue({ jobId, buyer: actor.claim }, sellerContextScopeHash(sellerContextChallengeScope(scope))).sessionNonce;
    };
    const sessionNonce = nonce ?? (candidate ? issueCandidate() : await issue({ jobId, actor }));
    const bundle = presentationFor(presenter, sessionNonce, state.time);
    bundleChange?.(bundle);
    bundle.presentation.signatures[0].signature = presenter.signBytes(Buffer.from(`dacs-bundle-presentation:v1:${identityBundleHash(bundle)}`)).toString('base64url');
    const scope = { ...w.scopeFor(jobId, actor), buyerBundleHash: identityBundleHash(bundle) };
    scopeChange?.(scope);
    bundleTamper?.(bundle);
    const body = { scope, buyerIdentityBundle: bundle };
    bodyChange?.(body);
    const signed = await w.sign({ jobId, actor, body, hash: sha256Hex(canonicalize(body.scope)), path: SELLER_CONTEXT_PATH, delegation, ...signOptions });
    return { ...signed, url: SELLER_CONTEXT_PATH, body, scope, bundle, nonce: sessionNonce };
  };
  const rowOf = (jobId = JOB) => admission.admissionRecord(jobId);
  const challengeOf = (nonce) => w.store.challenges.retained(nonce);
  const openHolds = () => counts.holds.filter((request) => !counts.releases.some((release) => release.hold === request.hold));
  const internals = sellerStoreInternals(w.store);
  /** Waits for every unfinished provider task and for the job's mutex, which a failed admission's compensation holds. */
  const settleJob = async (jobId = JOB) => { await drain(); await admission.jobEffectMutex(jobId).run(() => {}); await drain(); };
  const privateRow = (jobId = JOB) => JSON.parse(internals.db.prepare('SELECT record FROM kit_context_admissions WHERE jobId = ?').get(jobId).record);
  /**
   * A fresh host on this world's store and journal files, as after a restart: this host's store and journal are closed, its in-memory work is
   * gone, and the new world starts at this one's wall clock with a new store generation.
   */
  const restartHost = async () => {
    w.store.close();
    journal.close?.();
    const next = await contextWireWorld(t, { requireDelegation, storeOptions, resume: { directory: w.directory, generation: state.generation } });
    next.state.time = state.time;
    return next;
  };
  return { ...w, restartHost, challenges: () => w.store.challenges, handler, route, admission, countingAdmission, coordinator, capacity, counts, behaviour, provider, post, issue, startContext, rowOf, privateRow, challengeOf, openHolds, internals,
    operationOf, drain, settleJob, acquisitions, reserved, completions, presentAnswer, routeOptions, other, wire,
    tick: (ms) => { state.mono += ms; } };
}
