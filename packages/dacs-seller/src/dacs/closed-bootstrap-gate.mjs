// The gate that keeps a purchase from starting anywhere but the context route: a proposal, commitment, payment or bundle step
// goes ahead only for a job whose context admission settled with a success outcome and whose purchase tuple is kept.
import { DACS_SELLER_HTTP_PATHS } from '@kynesyslabs/dacs/wire';
import { canonicalize } from './listing.mjs';

const LIVE_ADMISSION_STATES = new Set(['intent', 'admitted', 'running']);
const CLOSED = Object.freeze({ code: 'context_admission_closed', status: 409 });
const STILL_ADMITTING = Object.freeze({ code: 'session_admission_unavailable', status: 503 });
const TUPLE_MISSING = Object.freeze({ code: 'tp1_purchase_profile_mismatch', status: 500 });

/**
 * Builds the gate over `admission(jobId)`, the synchronous read of a job's admission row (or null), `purchaseProfile(jobId)`, the
 * tuple the store kept for the job (or null), and `profile`, the tuple this host derives. Returns `({ route, jobId })` answering
 * null to let the request on, or a refusal `{ code, status }`: `context_admission_closed` 409 for a job with no row, a closed row
 * or a settled row that is not a success; `session_admission_unavailable` 503 while the row is still being admitted;
 * `tp1_purchase_profile_mismatch` 500 for a successful job whose kept tuple is missing or differs. The context route owns its
 * admission and is never refused. The same function is registered with the reservation coordinator and handed to the agent.
 */
export function createClosedBootstrapGate({ admission, purchaseProfile, profile }) {
  if (typeof admission !== 'function' || typeof purchaseProfile !== 'function' || profile === null || typeof profile !== 'object') {
    throw new TypeError('the closed-bootstrap gate needs the admission and purchase tuple readers and the host profile');
  }
  const hostProfile = canonicalize(profile);
  return ({ route, jobId }) => {
    if (route === DACS_SELLER_HTTP_PATHS.context) return null;
    const row = admission(jobId);
    if (row === null) return CLOSED;
    if (LIVE_ADMISSION_STATES.has(row.state)) return STILL_ADMITTING;
    if (row.state !== 'settled' || row.contextOutcome !== 'success') return CLOSED;
    const kept = purchaseProfile(jobId);
    return kept !== null && canonicalize(kept) === hostProfile ? null : TUPLE_MISSING;
  };
}
