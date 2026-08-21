import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  installDacsRoleServiceProcessHooksV1,
  type DacsProcessSignalTargetV1,
} from "../src/index.js";

class Signals extends EventEmitter implements DacsProcessSignalTargetV1 {
  override on(event: "SIGINT" | "SIGTERM", listener: () => void): this {
    return super.on(event, listener);
  }

  override off(event: "SIGINT" | "SIGTERM", listener: () => void): this {
    return super.off(event, listener);
  }
}

describe("role service process supervision", () => {
  it("stops exactly once on the first process signal and publishes a bounded result", async () => {
    const target = new Signals();
    const stop = vi.fn(async () => undefined);
    const observed = vi.fn(async () => undefined);
    const hooks = installDacsRoleServiceProcessHooksV1({ stop }, {
      signalTarget: target,
      onShutdown: observed,
    });

    target.emit("SIGTERM");
    target.emit("SIGINT");
    const result = await hooks.waitForShutdown();
    expect(result).toEqual({ reason: "SIGTERM", status: "stopped" });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(observed).toHaveBeenCalledWith(result);
    expect(target.listenerCount("SIGTERM")).toBe(0);
    expect(target.listenerCount("SIGINT")).toBe(0);
    await expect(hooks.shutdown()).resolves.toBe(result);
  });

  it("does not expose thrown shutdown details and ignores observer failure", async () => {
    const privateFailure = new Error("provider URL and secret must stay private");
    const hooks = installDacsRoleServiceProcessHooksV1({
      stop: async () => { throw privateFailure; },
    }, {
      signalTarget: new Signals(),
      onShutdown: () => { throw new Error("logging offline"); },
    });
    await expect(hooks.shutdown("manual")).resolves.toEqual({
      reason: "manual",
      status: "failed",
      reasonCode: "service-stop-failed",
    });
  });

  it("can remove hooks without stopping the service", () => {
    const target = new Signals();
    const stop = vi.fn(async () => undefined);
    const hooks = installDacsRoleServiceProcessHooksV1({ stop }, {
      signalTarget: target,
    });
    hooks.dispose();
    target.emit("SIGTERM");
    expect(stop).not.toHaveBeenCalled();
  });
});
