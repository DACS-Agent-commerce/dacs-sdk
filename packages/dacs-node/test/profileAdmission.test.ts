import { describe, expect, it, vi } from "vitest";
import { createDacsLiveRoleServiceV1 } from "../src/service.js";
import { createDacsLiveRoleRuntimeV1 } from "../src/roleRuntime.js";
import { createDacsPurchaseQueueExecutorV1 } from "../src/purchaseQueue.js";

describe("host corrective profile admission", () => {
  it("refuses role runtime before opening secrets or adapter authority", async () => {
    const touched = vi.fn();
    await expect(createDacsLiveRoleRuntimeV1({ get config() { touched(); return {}; } } as never))
      .rejects.toThrow(/unreleased/);
    expect(touched).not.toHaveBeenCalled();
  });

  it.each(["live", "simulation"] as const)("refuses a %s label on a live service before callbacks", (executionMode) => {
    const callback = vi.fn();
    const options = {
      executionMode, config: {}, database: {}, workerId: "profile-test", peerAuthority: "peer",
      peerEndpoint: "https://peer.example", resolveIdentity: callback,
      validatePayload: callback, signTransportEnvelope: callback, handleMessage: callback,
      createOperations: callback,
    };
    expect(() => createDacsLiveRoleServiceV1(options as never)).toThrow(/unreleased/);
    expect(callback).not.toHaveBeenCalled();
  });

  it.each(["live", "simulation"] as const)("refuses %s purchase queue resources before reading the plan", (executionMode) => {
    const inspected = vi.fn();
    const options = { executionMode, database: {}, workerId: "profile-test",
      get prepared() { inspected(); return { executionMode: "simulation" }; } };
    expect(() => createDacsPurchaseQueueExecutorV1(options as never)).toThrow(/unreleased/);
    expect(inspected).not.toHaveBeenCalled();
  });
});
