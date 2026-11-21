// The wait for a seller CREATE that a node may include after the wallet's own
// inclusion wait has ended. It reads the write back and does nothing else: no
// signature, wallet request, recovery send or new intent.

// The wait ends this long after the wallet answered for the write, and reads back once per poll.
const LATE_WRITE_WATCH_MS = 30 * 60_000, LATE_WRITE_POLL_MS = 5_000;

/** True while a write the wallet answered for at `issuedAt` (ms) is still inside its wait at time `now` (ms). */
export function lateWriteWatchOpen(issuedAt, now) {
  return Number.isSafeInteger(issuedAt) && now < issuedAt + LATE_WRITE_WATCH_MS;
}

// The caller's authorization, asked before each further readback: anything but true, or a throw, closes it.
async function stillAuthorized(authorize) {
  try { return await authorize() === true; } catch { return false; }
}

/**
 * Waits on a write whose readback `first` answered. While the readback is pending it asks `excluded` (the write's
 * exclusion rule) and stops with `{disposition:'excluded', reason}` when that answers a reason. Otherwise it sleeps
 * one poll and reads back again with `readBack`, until the readback is no longer pending, `authorize` no longer
 * answers true, or 30 minutes have passed since `issuedAt`. Returns the last readback or the exclusion; a throw from
 * `readBack` or `sleep` reaches the caller.
 */
export async function watchLateWrite({ first, readBack, issuedAt, now, sleep, authorize, excluded }) {
  let readback = first;
  while (readback.disposition === 'pending') {
    const reason = await excluded(readback);
    if (reason !== null) return { disposition: 'excluded', reason };
    const left = issuedAt + LATE_WRITE_WATCH_MS - now();
    if (left <= 0) return readback;
    await sleep(Math.min(LATE_WRITE_POLL_MS, left));
    if (!await stillAuthorized(authorize)) return readback;
    readback = await readBack();
  }
  return readback;
}
