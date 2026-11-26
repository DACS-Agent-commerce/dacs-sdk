// The seller host's authority stages, in order: the session's read-only capability, the production reader, the TP-1 binding,
// and, under the state lock, the effect history, the one effect boundary and the session's finalization.
import { join } from 'node:path';
import { TP1_APPROVED_IDENTITY_RECORD, WireError, bindTp1Profile } from '@kynesyslabs/dacs/wire';
import { createSellerAuthorityReader } from './authority-reader.mjs';
import { createBootstrapScopes } from './bootstrap-scope.mjs';
import { boundedCall, isBoundedCallTimeout } from './bounded-call.mjs';
import { WRITE_FEE_CEILING_OS, createEffectBoundary } from './effect-boundary.mjs';
import { createEffectHistory, initHistory } from './effect-history.mjs';

// Each authority read, the binding read included, ends within this many milliseconds.
const TP1_AUTHORITY_TIMEOUT_MS = 10000;
const EFFECTS_DIRECTORY = 'effects';
const AUTHORITY_MEMBERS = Object.freeze(['authorityRpc', 'context', 'connectionGeneration']);
// The fee ceiling the boundary and the session are finalized with, as a decimal OS amount.
const FEE_CEILING_OS = WRITE_FEE_CEILING_OS.toString();
// The effect boundary's clock: a monotonic source and a cancellable timer.
const MONOTONIC_CLOCK = Object.freeze({
  now: () => performance.now(),
  after: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
});

// A stalled read ends as `tp1_authority_timeout` with the deadline as its cause; any other failure is the reader's own.
// The wire keeps the reader it is bound with and calls it on every signed request, so the deadline is on the reader itself.
const withinAuthorityDeadline = (work) => boundedCall(work, { timeoutMs: TP1_AUTHORITY_TIMEOUT_MS }).catch((error) => {
  if (isBoundedCallTimeout(error)) throw new WireError('tp1_authority_timeout', 500, undefined, error);
  throw error;
});

function checkWalletSession(walletSession) {
  if (!AUTHORITY_MEMBERS.every((name) => typeof walletSession?.authority?.[name] === 'function') || typeof walletSession.connectionAuthority !== 'function'
    || typeof walletSession.finalize !== 'function' || (walletSession.close !== undefined && typeof walletSession.close !== 'function')) {
    throw new TypeError('walletSession needs authority { authorityRpc, context, connectionGeneration }, connectionAuthority and finalize functions, and close when given');
  }
}

/**
 * Opens the first three stages and resolves `{ binding, local(), bootstrap, finalize(input), close() }`. `walletSession` is the
 * session port: its read-only `authority` capability, its `connectionAuthority` reader, `finalize(input)` and an optional
 * `close()`; once its shape is checked the stages own it. The other inputs feed the reader and the bootstrap scopes.
 * `binding` is made through the production reader, each read within 10,000 ms; each read's abort signal, which the reader
 * passes to `participantImplementations.entriesFor`, is aborted when the read ends or times out. `local()` reads the current connection.
 * `finalize({ dataDirectory, stopped, stateLock })`, called under the state lock, creates and syncs `<dataDirectory>/effects`,
 * builds the one effect boundary over `binding`, finalizes the session with it and resolves `{ effectBoundary, session }`.
 * `close()` closes the finalized session, then the port, once. Throws TypeError for a malformed port. Rejects with a missing
 * input's TypeError, the binding's own error (`tp1_*`; `tp1_authority_timeout` after 10,000 ms) or the failing finalize
 * step's error, each after closing what the stages acquired.
 */
export async function openSellerStages({ walletSession, participantImplementations, sellerClaim, listingPin, retainedJob, maxConcurrent }) {
  checkWalletSession(walletSession);
  const local = () => {
    const { endpoint, transportAuthority, connectionId } = walletSession.authority.context();
    return { endpoint, transportAuthority, connectionId };
  };
  let session = null, finalizing = false, closing = null;
  // Runs once; a later call returns the same outcome, so the host's own cleanup reports a close that failed here.
  const close = () => closing ??= (async () => {
    try { await session?.close(); } finally { await walletSession.close?.(); }
  })();
  let bootstrap, binding;
  try {
    bootstrap = createBootstrapScopes({ sellerClaim, listingPin, retainedJob, maxConcurrent });
    const reader = createSellerAuthorityReader({ connectionAuthority: walletSession.connectionAuthority, identityRecord: TP1_APPROVED_IDENTITY_RECORD,
      claim: sellerClaim, listingPin, bootstrap, retainedJob, participantImplementations });
    // Each read gets its own signal, aborted when the read ends or its deadline passes, so the host's enrollment source can stop.
    const readAuthority = (scope) => {
      const read = new AbortController();
      return withinAuthorityDeadline(() => reader(scope, read.signal)).finally(() => read.abort());
    };
    binding = await withinAuthorityDeadline(() => bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: local(), readAuthority }));
  } catch (error) {
    // The binding error is the one reported; a failed close travels with it as `cleanupError` where the error can carry it.
    await close().catch((cleanupError) => { try { Object.defineProperty(error, 'cleanupError', { value: cleanupError }); } catch { /* reported without it */ } });
    throw error;
  }

  async function finalize({ dataDirectory, stopped, stateLock }) {
    if (finalizing) throw new TypeError('the seller stages finalize once');
    finalizing = true;
    try {
      await initHistory(join(dataDirectory, EFFECTS_DIRECTORY));
      const effectBoundary = createEffectBoundary({ stopped, binding, currentLocal: local, feeCeilingOs: FEE_CEILING_OS,
        history: createEffectHistory({ dataDirectory }), clock: MONOTONIC_CLOCK });
      const finalized = await walletSession.finalize({ binding, effectBoundary, stopped, feeCeilingOs: FEE_CEILING_OS, stateLock, dataDirectory });
      if (typeof finalized?.close !== 'function') throw new TypeError('the finalized wallet session needs close()');
      session = finalized;
      return Object.freeze({ effectBoundary, session });
    } catch (error) {
      // The caller's cleanup calls close() again and receives a failed close from there.
      await close().catch(() => {});
      throw error;
    }
  }
  return Object.freeze({ binding, local, bootstrap, finalize, close });
}
