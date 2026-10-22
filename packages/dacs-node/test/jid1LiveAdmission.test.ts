import { afterEach, describe, expect, it, vi } from "vitest";

import { UnsupportedCapabilityError } from "../../../src/errors.js";
import * as liveProfile from "../../../src/negotiate/liveProfile.js";
import { createDacsX402BuyerPaymentTrackV1 } from "../src/index.js";

const MESSAGE = "Live JID-1 actions are unavailable: the pinned Standard has no coordinated corrective release";

afterEach(() => vi.restoreAllMocks());

describe("public buyer payment track live admission", () => {
  function options() {
    const effect = vi.fn(() => { throw new Error("payment capability was consumed"); });
    return {
      effect,
      input: {
        database: {
          metadata: { mode: "live-demos", role: "buyer" },
          loadEffectInput: effect,
          putEffectIntent: effect,
        },
        workerId: "buyer-admission-test",
        settlementStore: {
          load: effect, claim: effect, isCurrent: effect,
          grantRecovery: effect, recordDisclosure: effect, recordOutcome: effect,
        },
        authorizationProvider: {
          authorizeIntent: effect, lookup: effect, authenticate: effect,
        },
        transport: { submitRetained: effect },
        walletSpendAuthority: { reserve: effect, reconcile: effect },
        finalityBlocks: 1,
        prepareIntent: effect,
        authorizePreparedIntent: effect,
      },
    };
  }

  it("refuses custom authorization and paid callbacks before constructing a live track", () => {
    const { input, effect } = options();
    expect(() => createDacsX402BuyerPaymentTrackV1(input as never))
      .toThrow(UnsupportedCapabilityError);
    expect(() => createDacsX402BuyerPaymentTrackV1(input as never)).toThrow(MESSAGE);
    expect(effect).not.toHaveBeenCalled();
  });

  it("rechecks the real gate before invocation can recover retained input or claim an effect", async () => {
    const { input, effect } = options();
    // Construct below the boundary only for this check, then restore the real
    // gate. The public invocation must independently refuse retained recovery.
    const construction = vi.spyOn(liveProfile, "requireJid1LiveProfile")
      .mockImplementationOnce(() => undefined);
    const track = createDacsX402BuyerPaymentTrackV1(input as never);
    construction.mockRestore();
    const read = vi.fn(() => { throw new Error("invocation was consumed"); });
    const result = track(new Proxy({}, { get: read }) as never);
    await expect(result).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(result).rejects.toThrow(MESSAGE);
    expect(read).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
  });
});
