import { setImmediate } from "node:timers/promises";
import { expect, vi } from "vitest";

// Real time the filesystem work may take. It is generous for slow storage and
// stays under Vitest's 5 s test timeout, so a stuck operation fails here.
const REAL_IO_LIMIT_MS = 4_000;

/** Drive real filesystem work and virtual poll timers with independent clocks. */
export async function expectMonotonicTimeout(
  operation: () => Promise<unknown>,
  budget: number,
  poll: number,
  jump: number,
  message: RegExp,
): Promise<void> {
  const epoch = Date.now();
  let elapsed = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const schedule = globalThis.setTimeout;
  const wall = vi.spyOn(Date, "now").mockImplementation(() =>
    epoch + elapsed + (elapsed > 0 && elapsed < budget * 3 ? jump : 0));
  const monotonic = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) =>
    schedule(() => { elapsed += Math.max(delay ?? 0, budget / 5); callback(...args); }, delay));
  let settled = false;
  let failure: unknown;
  const pending = operation().then(
    (value: unknown) => { failure = value; settled = true; },
    (error: unknown) => { failure = error; settled = true; },
  );
  // process.hrtime is not mocked above, so it measures the real time spent.
  const realStart = process.hrtime.bigint();
  const realElapsedMs = () => Number(process.hrtime.bigint() - realStart) / 1e6;
  try {
    // Let filesystem callbacks complete without advancing time until a poll is scheduled.
    // Slow storage needs more turns, so real time bounds the wait, not a turn count.
    while (!settled && realElapsedMs() < REAL_IO_LIMIT_MS) {
      await setImmediate();
      if (vi.getTimerCount() > 0) await vi.runOnlyPendingTimersAsync();
    }
    expect(settled, `operation still pending after ${REAL_IO_LIMIT_MS} ms of real time`).toBe(true);
    expect(typeof failure === "object" && !(failure instanceof Error) ? JSON.stringify(failure) : String(failure)).toMatch(message);
    expect(elapsed).toBeGreaterThanOrEqual(budget);
    expect(elapsed).toBeLessThanOrEqual(budget + poll);
    await pending;
  } finally {
    timer.mockRestore();
    monotonic.mockRestore();
    wall.mockRestore();
    vi.useRealTimers();
  }
}
