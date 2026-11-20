// The seller host's authority stages, in order: the kit session's read-only authority capability, the production
// authority reader over it, the TP-1 binding read through that reader, then, once the host holds the state lock, the
// effect history, the host's one effect boundary and the session's finalization. Nothing that can sign or send exists
// before the last stage, and a failed stage closes what the stages acquired.
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
 * Opens the host's first three stages and returns `{ binding, local(), bootstrap, finalize(input), close() }`.
 * - `walletSession` is the kit session port: `authority` (its read-only capability `{authorityRpc, context, connectionGeneration}`),
 *   `connectionAuthority` (the connection reader over that capability), `finalize(input)` (resolves the effect-capable session,
 *   with `close()`) and, optionally, `close()`. Once its shape is checked the stages own it: every later failure and `close()` close it.
 * - `participantImplementations`, `sellerClaim`, `listingPin` and `retainedJob` are the reader's inputs (see
 *   `createSellerAuthorityReader`); `maxConcurrent` bounds the live bootstrap scopes.
 * `binding` is bound to the SDK-approved record through the production reader, whose every read ends within 10,000 ms;
 * `local()` reads the session's current connection; `bootstrap` holds the request-local scopes.
 * `finalize({ dataDirectory, stopped, stateLock })`, called once the host holds the state lock, initialises and syncs
 * `<dataDirectory>/effects`, builds the host's one effect boundary over `binding` and finalizes the session with it; it
 * resolves `{ effectBoundary, session }`. `close()` closes the finalized session, then the port, once.
 * Throws TypeError for a malformed port before anything is read. Rejects with TypeError for a missing reader input, the
 * binding's own error (`tp1_*`, with the reader's error as its cause; `tp1_authority_timeout` after 10,000 ms), and
 * `finalize` with the failing step's error; each of these first closes what the stages acquired.
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
    const readAuthority = (scope) => withinAuthorityDeadline(() => reader(scope));
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
