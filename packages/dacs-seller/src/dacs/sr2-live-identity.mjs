// What the live SR-2 adapter takes as its chain identity, and how it compares two network bindings. The identity comes from the
// binding `bindTp1Profile` made, never from a pin alone and never from the simulated fixture chain.
import { TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES } from '@kynesyslabs/dacs/wire';

// What every actor on one chain shares: each actor's own endpoint and transport authority are left out.
const SHARED_TUPLE = Object.freeze(['network', 'chainIdentity', 'pinVersion']);
const refuse = (code, message) => Object.assign(new Error(message), { code });

/**
 * The chain identity a live adapter expects: `binding.profile.chainIdentity`, which must equal the source capability's pinned
 * identity. The caller proves the binding is genuine with the wire's `assertTp1Binding`.
 * Throws TypeError for a value that is not a binding, an error with code `tp1_identity_fixture` when either identity is a simulated
 * fixture chain, and one with code `invalid-chain` when the two differ.
 */
export function liveExpectedIdentity({ binding, sourceCapability }) {
  const identity = binding?.profile?.chainIdentity;
  if (typeof identity !== 'string' || typeof binding.localDigest !== 'string') throw new TypeError('binding must come from bindTp1Profile');
  const pinned = sourceCapability.pins.chainIdentity;
  if (TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES.includes(identity) || TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES.includes(pinned)) {
    throw refuse('tp1_identity_fixture', 'the simulated fixture chain is not a live chain identity');
  }
  if (identity !== pinned) throw refuse('invalid-chain', 'the source pin names another chain than the binding');
  return identity;
}

/** True when two network bindings agree on the network, chain identity and pin version, whatever endpoint and transport authority each names. */
export function sameSharedTuple(a, b) {
  return SHARED_TUPLE.every((member) => typeof a?.[member] === 'string' && a[member] === b?.[member]);
}
