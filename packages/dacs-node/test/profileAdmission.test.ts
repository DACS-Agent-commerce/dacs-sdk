import { describe, expect, it, vi } from "vitest";
import { createDacsLiveRoleServiceV1 } from "../src/service.js";
import { createDacsPurchaseQueueExecutorV1 } from "../src/purchaseQueue.js";

describe("host corrective profile admission", () => {
  it("refuses a live service before creating operations or signing transport messages", () => {
    const callback = vi.fn();
    const options = {
      config: {}, database: {}, workerId: "profile-test", peerAuthority: "peer",
      peerEndpoint: "https://peer.example", resolveIdentity: callback,
      validatePayload: callback, signTransportEnvelope: callback, handleMessage: callback,
      createOperations: callback,
    };
    expect(() => createDacsLiveRoleServiceV1(options as never)).toThrow(/unreleased/);
    expect(callback).not.toHaveBeenCalled();
  });

  it("does not let a purchase plan select simulation or bypass the release gate", () => {
    const inspected = vi.fn();
    const options = { database: {}, workerId: "profile-test",
      get prepared() { inspected(); return { executionMode: "simulation" }; } };
    expect(() => createDacsPurchaseQueueExecutorV1(options as never)).toThrow(/unreleased/);
    expect(inspected).not.toHaveBeenCalled();
  });
});
