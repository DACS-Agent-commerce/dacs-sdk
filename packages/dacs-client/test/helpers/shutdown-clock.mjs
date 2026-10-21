// A manual clock for the operator shutdown budgets. No wall-clock window.
// Sleeps are keyed by their duration, so approvalMs (the approval deadline,
// started when close() starts) must differ from graceMs, laneMs and the 50 ms
// lane poll: then it fires only when a test advances it.
export function shutdownClock({ graceMs = 30, laneMs = 100, approvalMs = 15, autoLanes = false } = {}) {
  if ([graceMs, laneMs, 50].includes(approvalMs)) throw new TypeError('approvalMs must differ from graceMs, laneMs and the 50 ms lane poll');
  let now = 0;
  const pending = new Map(), observers = new Map();
  return {
    graceMs, laneMs, approvalMs, now: () => now,
    sleep(ms) {
      if(autoLanes && ms === 50)return new Promise(resolve => setTimeout(() => { now += ms; resolve(); }, ms));
      return new Promise(resolve => {
        const list = pending.get(ms) ?? []; list.push(resolve); pending.set(ms, list);
        for (const observe of observers.get(ms) ?? []) observe();
        observers.delete(ms);
      });
    },
    waiting(ms) {
      if (pending.get(ms)?.length) return Promise.resolve();
      return new Promise(resolve => { const list = observers.get(ms) ?? []; list.push(resolve); observers.set(ms, list); });
    },
    async advance(ms, elapsed = ms) {
      await this.waiting(ms); now += elapsed;
      for (const resolve of pending.get(ms) ?? []) resolve(); pending.delete(ms);
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}
