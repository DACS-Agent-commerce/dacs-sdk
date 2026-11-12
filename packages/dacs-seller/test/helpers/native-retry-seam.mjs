// Test-only seam for the native delivery tests: it lets one retry cross the
// wire lease explicitly and routes crash setup through an injected adapter
// instead of a journal-specific reserve/finish call. It resets no clock to a
// fixed time, and it never touches a wallet, a journal or retained work.
const MODES = new Set(['legacy', 'wire']);
const CUT_POINTS = new Set(['reservation-before-work', 'work-before-completion']);

const requireFunction = (value, name) => {
  if (typeof value !== 'function') throw new TypeError(`native retry seam: ${name} must be a function`);
  return value;
};

const readMillis = (read, name) => {
  const value = read();
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`native retry seam: ${name} must return a finite number`);
  return value;
};

const readLease = (leaseUntil) => {
  const lease = leaseUntil();
  if (lease !== null && (typeof lease !== 'number' || !Number.isFinite(lease))) throw new TypeError('native retry seam: leaseUntil must return a finite number or null');
  return lease;
};

// Returns a frozen cut whose body is a private copy of the caller's bytes.
// Throws TypeError for an unknown point, an empty job id, a path that is not
// absolute, or a body that is not a Uint8Array.
function copyCut(cut) {
  if (cut === null || typeof cut !== 'object') throw new TypeError('native retry seam: cut must be an object');
  const { point, jobId, path, rawBody } = cut;
  if (!CUT_POINTS.has(point)) throw new TypeError(`native retry seam: unknown cut point ${String(point)}`);
  if (typeof jobId !== 'string' || jobId === '') throw new TypeError('native retry seam: cut jobId must be a non-empty string');
  if (typeof path !== 'string' || !path.startsWith('/')) throw new TypeError('native retry seam: cut path must start with /');
  if (!(rawBody instanceof Uint8Array)) throw new TypeError('native retry seam: cut rawBody must be a Uint8Array');
  return Object.freeze({ point, jobId, path, rawBody: Uint8Array.from(rawBody) });
}

/**
 * Builds the seam over a fixture's clocks and its cut adapter.
 *
 * `legacy` mode keeps the base's retry behaviour: `beforeRetry` does nothing.
 * `wire` mode makes `beforeRetry` advance the wall and monotonic clocks together
 * by `max(0, leaseUntil() - wallNow())` (no advance when `leaseUntil()` is null)
 * and check that the lease then ended and both clocks moved. `establishCut` hands
 * the adapter a frozen copy of the cut and returns the adapter's result.
 *
 * @param {{wallNow:()=>number, monotonicNow:()=>number, advance:(milliseconds:number)=>void,
 *   leaseUntil:()=>number|null, mode:'legacy'|'wire', establishCut:(cut:object)=>Promise<void>}} options
 * @returns {Readonly<{beforeRetry:()=>void, establishCut:(cut:object)=>Promise<void>}>}
 * @throws {TypeError} for an unknown mode or a missing function; `beforeRetry` also
 *   throws TypeError for a bad clock or lease reading, and Error when the advance
 *   leaves the lease live or leaves the monotonic clock behind the wall clock.
 */
export function createNativeRetrySeam(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('native retry seam: options must be an object');
  const { wallNow, monotonicNow, advance, leaseUntil, mode, establishCut } = options;
  if (!MODES.has(mode)) throw new TypeError(`native retry seam: unknown mode ${String(mode)}`);
  for (const [name, value] of Object.entries({ wallNow, monotonicNow, advance, leaseUntil, establishCut })) requireFunction(value, name);

  const beforeRetry = () => {
    if (mode === 'legacy') return;
    const lease = readLease(leaseUntil);
    if (lease === null) return;
    const wallBefore = readMillis(wallNow, 'wallNow');
    const monotonicBefore = readMillis(monotonicNow, 'monotonicNow');
    const lapse = Math.max(0, lease - wallBefore);
    if (lapse === 0) return;
    advance(lapse);
    const leaseAfter = readLease(leaseUntil);
    if (leaseAfter !== null && readMillis(wallNow, 'wallNow') < leaseAfter) throw new Error('native retry seam: the lease is still live after the advance');
    if (readMillis(monotonicNow, 'monotonicNow') - monotonicBefore < lapse) throw new Error('native retry seam: the monotonic clock did not move with the wall clock');
  };

  return Object.freeze({ beforeRetry, establishCut: async (cut) => establishCut(copyCut(cut)) });
}
