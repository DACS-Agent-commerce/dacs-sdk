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
 * The scripted world for gate tests: a seller (default) or buyer composition on the exported transport owner, spied at the
 * inner signature. The owner is the exported one except for currentLocal(), which `replaceLocal(local)` makes report another
 * connection. `currentOwner()` is the current composition's owner; `clock` is the composition's mutable clock; `qualify` is
 * installed on a seller.
 */
export async function gateWorld(t, { seller = true, qualify, sessionOptions = {}, journalWrap } = {}) {
  const clock = { now: () => T0 };
  let owner, replaced = null;
  const w = await spiedWorld(t, {
    createSession: seller ? api.createNodeSellerComposition : api.createNodeWalletSession,
    ownerWrap: raw => { replaced = null; owner = { ...raw, currentLocal: () => replaced ?? raw.currentLocal() }; return owner; }, journalWrap,
    sessionOptions: { clock, ...(seller ? { approveConfirmedWrite: null, publications: sellerPublications(), ...(qualify ? { qualify } : {}) } : {}), ...sessionOptions },
  });
  return Object.assign(w, { clock, currentOwner: () => owner, replaceLocal: local => { replaced = local; } });
}

/**
 * Opens an effect pass the way its host does: it takes the owner's fence, registers the pass and releases the fence when
 * `run(work)` ends, whatever work does. `events` records every default step as `<step>:<phase>`; `pass` overrides any
 * member of the registered pass.
 */
export async function openPass(w, { pass = {}, events = [] } = {}) {
  const owner = w.currentOwner?.() ?? w.owner, lease = await owner.acquireConnectionFence();
  const step = name => ({ phase }) => { events.push(`${name}:${phase}`); };
  const handle = w.session.effectPass({ fence: lease, deadline: w.clock.now() + PASS_WINDOW_MS, refreshAuthority: step('authority'),
    finalStop: step('stop'), synchronousChecks: [step('sync')], feeCeilingOs: FEE_CEILING_OS, ...pass });
  const run = async work => {
    try { return await w.session.runInEffectPass(handle, work); } finally { lease.release(); }
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
