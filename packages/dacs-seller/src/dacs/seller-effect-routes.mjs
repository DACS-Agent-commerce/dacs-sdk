// The per-route rules of the signed effect routes that have a row: where the route's effect lands, how a
// retained attempt is recovered, when an attempt may end without an outcome, and what is read again, read
// only, before a completed answer is signed again. A route without a row ends by the generic rule of the
// wire store. Rows are looked up by the exact request path, so a read route or a path of another owner
// never reaches one.
import { DACS_SELLER_HTTP_PATHS as PATHS } from '@kynesyslabs/dacs/wire';

const NO_EFFECT = Object.freeze({ kind: 'no-effect' });
const OPEN = Object.freeze({ kind: 'open' });

// Evidence is `{ retained: 'none' | 'work' | 'unknown', workerQuiescent, signatureIntent, createIntent, final }`, read from the agent inside
// the job's lock. Unknown evidence is never proof that nothing was done.
const noWorkRetained = (evidence) =>evidence.retained === 'none' && !evidence.signatureIntent && !evidence.createIntent;

const row = (path, { sink, idempotenceKey, endAfter }) => Object.freeze({
  sink,
  idempotenceKey,
  // The agent's own recovery runs under the job's lock and settles through the transport frame.
  recover: ({ agent, request, body, rawBody, transport }) => agent.reconcileTransport({ request, body, rawBody, transport }),
  endAfter,
  revalidate: ({ agent, jobId, outcome }) => agent.revalidateCompletedAnswer({ path, jobId, outcome }),
});

// A bundle route has no sink and never completes: it refuses by name. Its attempt ends with no outcome only when the
// job's lock shows no unfinished countersignature work.
const bundleRow = (path) => row(path, {
  sink: 'none',
  idempotenceKey: 'none',
  endAfter: (answer, evidence) => (answer.noEffect && noWorkRetained(evidence) && evidence.workerQuiescent ? NO_EFFECT : OPEN),
});

// A commitment route's sink is the finality commitment CREATE. Its attempt ends with no outcome only when the job's lock shows no
// commitment work of any kind (no CREATE time, publication request, early attempt or commitment); once the CREATE may have been
// asked for, the attempt stays open until a read of the source settles it.
const commitmentRow = (path) => row(path, {
  sink: 'the finality commitment CREATE at its canonical address',
  idempotenceKey: 'commitment:<canonical address of the job>',
  endAfter: (answer, evidence) => {
    if (answer.retry || answer.noEffect) return noWorkRetained(evidence) && evidence.workerQuiescent ? NO_EFFECT : OPEN;
    return answer.status === 200 && evidence.final ? Object.freeze({ kind: 'outcome', outcome: { status: answer.status, text: answer.text }, cleanup: 'route' }) : OPEN;
  },
});

/** The table of the routes this module owns, by exact request path. Each row is `{ sink, idempotenceKey, recover, endAfter, revalidate }`.
 * `recover(input)` runs the agent's locked recovery once. `endAfter(answer, evidence)` returns the end decision of the wire attempt
 * (`{ kind: 'outcome', outcome, cleanup }`, `{ kind: 'no-effect' }` or `{ kind: 'open' }`) from the classified answer, which carries the
 * exact stored `text`, and the agent's evidence; it reads and writes nothing. `revalidate(input)` resolves after the agent reads the
 * sources of a completed answer again and throws what the agent throws. */
export const SELLER_EFFECT_ROUTES = Object.freeze({
  [PATHS.proposals]: row(PATHS.proposals, {
    sink: 'the seller signature record and the retained contribution',
    idempotenceKey: 'signature:<sha256 of the signed Agreement bytes>',
    // Progress ends with no outcome only when nothing of the proposal was signed or kept; once work is retained the attempt stays open.
    endAfter: (answer, evidence) => {
      if (answer.retry || answer.noEffect) return noWorkRetained(evidence) ? NO_EFFECT : OPEN;
      return answer.status === 200 && evidence.final ? Object.freeze({ kind: 'outcome', outcome: { status: answer.status, text: answer.text }, cleanup: 'route' }) : OPEN;
    },
  }),
  [PATHS.bundleRequest]: bundleRow(PATHS.bundleRequest),
  [PATHS.bundleCountersignature]: bundleRow(PATHS.bundleCountersignature),
  [PATHS.commitments]: commitmentRow(PATHS.commitments),
  [PATHS.commitmentSignature]: commitmentRow(PATHS.commitmentSignature),
});

const ROUTES_WITHOUT_SIGNATURE = Object.freeze(Object.fromEntries(Object.entries(SELLER_EFFECT_ROUTES).filter(([path]) => path !== PATHS.commitmentSignature)));

/** The rows enabled for one host: the commitments/signature row only when `commitOnSignature` is true. Throws a TypeError unless it is a boolean. */
export function createSellerEffectRoutes({ commitOnSignature } = {}) {
  if (typeof commitOnSignature !== 'boolean') throw new TypeError('commitOnSignature must be boolean');
  return commitOnSignature ? SELLER_EFFECT_ROUTES : ROUTES_WITHOUT_SIGNATURE;
}
