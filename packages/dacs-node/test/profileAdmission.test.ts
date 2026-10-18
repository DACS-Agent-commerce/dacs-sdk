import { describe, expect, it, vi } from "vitest";
import { createDacsLiveRoleServiceV1 } from "../src/service.js";
import { createDacsLiveRoleRuntimeV1 } from "../src/roleRuntime.js";
import { createDacsPurchaseQueueExecutorV1 } from "../src/purchaseQueue.js";

describe("host corrective profile admission", () => {
  it("refuses all live guards under inherited simulation policy before dependencies", async () => {
    const touched = vi.fn();
    const options = Object.create({ executionMode: "simulation" });
    Object.defineProperty(options, "config", { get: touched });
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "executionMode");
    try {
      Object.defineProperty(Object.prototype, "executionMode", { value: "simulation", configurable: true });
      await expect(createDacsLiveRoleRuntimeV1(options)).rejects.toThrow(/unreleased/);
      const serviceOptions = {
        config: {}, database: {}, workerId: "profile-test", peerAuthority: "peer",
        peerEndpoint: "https://peer.example", resolveIdentity: touched,
        validatePayload: touched, signTransportEnvelope: touched, handleMessage: touched,
        createOperations: touched,
      };
      expect(() => createDacsLiveRoleServiceV1(serviceOptions as never)).toThrow(/unreleased/);
      expect(() => createDacsLiveRoleServiceV1(options)).toThrow(/closed data objects/);
      expect(() => createDacsPurchaseQueueExecutorV1(options)).toThrow(/unreleased/);
      expect(touched).not.toHaveBeenCalled();
    } finally {
      if (previous) Object.defineProperty(Object.prototype, "executionMode", previous);
      else Reflect.deleteProperty(Object.prototype, "executionMode");
    }
  });

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
