// Test-only hold on the transport owner's next getContext call: the transport awaits it
// right before an effectful request, so a test can change the world while it waits.
/** `hold()` makes the next `pass()` wait until the returned `release()` (or `fail(error)`); `reached` is true once it is waiting. */
export function contextGate() {
  let next = null;
  return {
    hold() {
      const held = { reached: false, release: null, fail: null, promise: null };
      held.promise = new Promise((resolve, reject) => { held.release = resolve; held.fail = reject; });
      next = held;
      return held;
    },
    async pass() {
      const waiting = next;
      next = null;
      if (!waiting) return;
      waiting.reached = true;
      await waiting.promise;
    },
  };
}
