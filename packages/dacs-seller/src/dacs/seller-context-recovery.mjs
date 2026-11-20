// What the wire context route runs for an accepted admission whose earlier attempt ended without an outcome: read what the provider
// retained, finish from it, or write only the Vets that are still missing.
import { SellerTransportError } from './seller-transport-auth.mjs';

const VET_WRITES = 2;
const PARTY_VET_NON_PASS = 'party_vet_non_pass';

/**
 * The work of a recovery attempt for the retained context `body`, as the function `(options) => answer` that `createContextAttempt` runs.
 * It reads the retained Vet records first with `provider.recoverBuyer`: a present answer or an authenticated Vet non-pass is returned for the
 * route to complete. Otherwise `provider.resumableBuyer` must prove that one or two writes are missing and nothing else is unresolved;
 * only then `provider.resolveBuyer` runs, under the attempt's own write authority, and writes what is missing. Any other result, an unknown
 * or possibly dispatched write included, throws SellerTransportError `operation_uncertain` (503) with cause `context_recovery_held`, and a
 * failed read throws its own error: the attempt stays open and nothing is written.
 */
export function resumeContext(provider, body) {
  return async (options) => {
    const recovered = await provider.recoverBuyer(structuredClone(body), options);
    if (recovered?.disposition === 'present' || recovered?.code === PARTY_VET_NON_PASS) return recovered;
    const cut = await provider.resumableBuyer(structuredClone(body), options);
    if (!Number.isSafeInteger(cut?.writes) || cut.writes < 1 || cut.writes > VET_WRITES) throw new SellerTransportError('operation_uncertain', 503, { cause: 'context_recovery_held' });
    return provider.resolveBuyer(structuredClone(body), options);
  };
}
