// The host's registry of context provider work. The provider keeps working after its HTTP answer has been sent (at the attempt's
// deadline, or when the host stops), so the host waits for it here before it closes the stores and releases the seller state lock.
import { SellerTransportError } from './seller-transport-auth.mjs';

/**
 * `track(start)` is the route's `trackContextWork`: it registers the work, then calls `start` once, and returns the work's own promise, whose
 * outcome stays the caller's to observe. The work stays registered until it has settled, whether it resolved or rejected. After `stop()` it
 * rejects with `seller_stopped` (503) and never calls `start`. `drain()` resolves once no registered work is left, including work registered
 * while it waited.
 */
export function createContextWorkRegistry() {
  const entries = new Set();
  let stopped = false;
  return Object.freeze({
    track(start) {
      if (stopped) return Promise.reject(new SellerTransportError('seller_stopped', 503));
      const entry = { settled: null };
      entries.add(entry);
      let work;
      try { work = Promise.resolve(start()); } catch (error) { work = Promise.reject(error); }
      entry.settled = work.then(() => {}, () => {});
      entry.settled.then(() => entries.delete(entry));
      return work;
    },
    stop() { stopped = true; },
    async drain() {
      while (entries.size > 0) await Promise.all([...entries].map((entry) => entry.settled));
    },
  });
}
