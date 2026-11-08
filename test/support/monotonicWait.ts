import { setImmediate } from "node:timers/promises";
import { expect, vi } from "vitest";

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
  try {
    // Let filesystem callbacks complete without advancing time until a poll is scheduled.
    for (let turn = 0; !settled && turn < 100_000; turn += 1) {
      await setImmediate();
      if (vi.getTimerCount() > 0) await vi.runOnlyPendingTimersAsync();
    }
    expect(settled).toBe(true);
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
