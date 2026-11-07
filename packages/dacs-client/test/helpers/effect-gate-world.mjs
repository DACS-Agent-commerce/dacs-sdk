import assert from 'node:assert/strict';
import { api, T0 } from './tp1-node-fixture.mjs';
import { spiedWorld } from './node-wallet-signing-spy.mjs';

export const FEE_CEILING_OS = '50000000000';
const PASS_WINDOW_MS = 10_000;

/** Returns fixture TEST- publications for a seller composition. */
export const sellerPublications = () => ({
  settlementPublication: { artifactKind: 'SettlementEvidence', authority: 'TEST-seller-settlement', phase: 'pay-dem', phaseIndex: 2, policy: api.DEVNET_SETTLEMENT_POLICY, railId: 'demos-native:DEM' },
  deliveryPublication: { artifactKind: 'Deliverable', authority: 'TEST-seller-delivery', phase: 'deliver-storage-program', phaseIndex: 3, policy: api.DEVNET_DELIVERY_POLICY },
  demoArtifactPublication: { authority: 'TEST-RUN-seller-parts-0001', policy: api.DEVNET_DEMO_ARTIFACT_POLICY, artifactKinds: [...api.DEVNET_DEMO_ARTIFACT_TYPES] },
});

/**
 * Wraps a transport owner for tests. While `reuseFence(true)` is set, a nested acquisition returns a
 * lease over the same context that releases nothing: it models the owning pass handing its fence to
 * the nested steps. `acquisitions()` counts every acquisition made through the wrapper;
 * `replaceLocal(local)` makes currentLocal() report another connection.
 */
export function reentrantOwner(owner) {
  let reuse = false, acquisitions = 0, replaced = null;
  return {
    ...owner,
    currentLocal: () => replaced ?? owner.currentLocal(),
    replaceLocal(local) { replaced = local; },
    reuseFence(on) { reuse = on; },
    acquisitions: () => acquisitions,
    async acquireConnectionFence(...args) {
      acquisitions += 1;
      return reuse ? Object.freeze({ context: owner.getContext(), release() {} }) : owner.acquireConnectionFence(...args);
    },
  };
}

/**
 * The scripted world for gate tests: a seller (default) or buyer composition whose owner is
 * reentrantOwner, spied at the inner signature. `currentOwner()` is the current composition's owner;
 * `clock` is the composition's mutable clock; `qualify` is installed on a seller. With `directOwner` the composition runs on
 * the exported owner itself, with no wrapper.
 */
export async function gateWorld(t, { seller = true, qualify, directOwner = false, sessionOptions = {} } = {}) {
  const clock = { now: () => T0 };
  let owner;
  const w = await spiedWorld(t, {
    createSession: seller ? api.createNodeSellerComposition : api.createNodeWalletSession,
    ownerWrap: raw => { owner = directOwner ? raw : reentrantOwner(raw); return owner; },
    sessionOptions: { clock, ...(seller ? { approveConfirmedWrite: null, publications: sellerPublications(), ...(qualify ? { qualify } : {}) } : {}), ...sessionOptions },
  });
  return Object.assign(w, { clock, currentOwner: () => owner });
}

/**
 * Opens an effect pass the way an owning EB pass does: it takes the owner's fence, registers the pass
 * and releases the fence when `run(work)` ends, whatever work does. `events` records every default
 * step as `<step>:<phase>`; `pass` overrides any member of the registered pass.
 */
export async function openPass(w, { pass = {}, events = [] } = {}) {
  const owner = w.currentOwner?.() ?? w.owner, lease = await owner.acquireConnectionFence();
  owner.reuseFence?.(true);
  const step = name => ({ phase }) => { events.push(`${name}:${phase}`); };
  const handle = w.session.effectPass({ fence: lease, deadline: w.clock.now() + PASS_WINDOW_MS, refreshAuthority: step('authority'),
    finalStop: step('stop'), synchronousChecks: [step('sync')], feeCeilingOs: FEE_CEILING_OS, ...pass });
  const run = async work => {
    try { return await w.session.runInEffectPass(handle, work); } finally { owner.reuseFence?.(false); lease.release(); }
  };
  return { handle, lease, events, run };
}

/** Runs `work` inside a fresh default pass of `w`. */
export const inPass = async (w, work) => (await openPass(w)).run(work);

/** Asserts that the owner's connection fence is free: an acquisition settles without waiting for a release. */
export async function assertFenceFree(owner) {
  const lease = await Promise.race([owner.acquireConnectionFence(), new Promise(resolve => setImmediate(resolve, 'blocked'))]);
  assert.notEqual(lease, 'blocked', 'the fence is still held');
  lease.release();
}

/** Returns a marker that turns true once any microtask has run after it was made: an await between two points shows. */
export function microtaskMarker() {
  const marker = { turned: false };
  queueMicrotask(() => { marker.turned = true; });
  return marker;
}
