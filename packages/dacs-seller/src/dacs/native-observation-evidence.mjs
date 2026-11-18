import { AsyncLocalStorage } from 'node:async_hooks';

const collectors = new AsyncLocalStorage();

/**
 * Runs `work` with a collector that receives the local refusal proofs the native anchor establishes while it runs.
 * A proof is `{kind, address, retainedHash, observedHash}`: an immutable scope conflict, an operator denial or an
 * authenticated contradiction of the retained record. The collector belongs to this call and its async continuations,
 * so concurrent calls never see each other's proofs, and nothing in a request can supply one.
 * Returns what `work` returns and rethrows what it throws. Throws TypeError for a malformed collector or work.
 */
export async function withNativeObservationEvidence(collector, work) {
  if (typeof collector !== 'function' || typeof work !== 'function') throw new TypeError('native observation evidence needs a collector and work functions');
  return collectors.run(collector, work);
}

/** Called by the native anchor at the check that establishes a refusal. Does nothing outside a collecting call. */
export function reportNativeRefusal(proof) {
  collectors.getStore()?.(Object.freeze({ ...proof }));
}
