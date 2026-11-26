import { describe, expect, it } from "vitest";

import { createRetainingDacsWalletSpendOperationLogV1 } from "../src/walletSpendTestnetOperationLog.js";

type Log = ReturnType<typeof createRetainingDacsWalletSpendOperationLogV1>;
type Claim = Parameters<Log["claim"]>[0];
type Complete = Parameters<Log["complete"]>[0];

const claim = (n: number, extra = ""): Claim => ({
  roleId: "buyer",
  operationId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  requestHash: `${String(n).padStart(2, "0")}${extra}`.padEnd(64, "a"),
  request: { operation: "reserve", n } as unknown as Claim["request"],
});

const finish = (input: Claim): Complete => ({
  roleId: input.roleId,
  operationId: input.operationId,
  requestHash: input.requestHash,
  response: { ok: input.operationId } as unknown as Complete["response"],
});

describe("retaining wallet-spend operation log", () => {
  it("keeps taking new claims past its limit while earlier operations are completed", async () => {
    const log = createRetainingDacsWalletSpendOperationLogV1(3);
    for (let n = 1; n <= 10; n += 1) {
      expect(await log.claim(claim(n))).toBe("new");
      await log.complete(finish(claim(n)));
    }
    expect(await log.load(claim(1))).toBeUndefined();
    expect((await log.load(claim(10)))?.response).toBeDefined();
  });

  it("never drops an unresolved claim and refuses a new one only while all are unresolved", async () => {
    const log = createRetainingDacsWalletSpendOperationLogV1(2);
    expect(await log.claim(claim(1))).toBe("new");
    expect(await log.claim(claim(2))).toBe("new");
    expect(await log.claim(claim(3))).toBe("full");
    expect(await log.claim(claim(1))).toBe("existing");
    await log.complete(finish(claim(2)));
    expect(await log.claim(claim(3))).toBe("new");
    expect(await log.load(claim(1))).toBeDefined();
    expect(await log.load(claim(2))).toBeUndefined();
  });

  it("keeps a completed operation readable until its minimum retention has passed", async () => {
    let clock = 1_000;
    const log = createRetainingDacsWalletSpendOperationLogV1(2, 500, () => clock);
    for (const n of [1, 2]) {
      expect(await log.claim(claim(n))).toBe("new");
      await log.complete(finish(claim(n)));
      clock += 100;
    }
    // Full, and both completed operations are younger than the minimum.
    expect(await log.claim(claim(3))).toBe("full");
    expect((await log.load(claim(1)))?.response).toBeDefined();
    expect((await log.load(claim(2)))?.response).toBeDefined();
    // Operation 1 completed at 1,000: kept for exactly 500 at 1,500, so it may go.
    clock = 1_499;
    expect(await log.claim(claim(3))).toBe("full");
    clock = 1_500;
    expect(await log.claim(claim(3))).toBe("new");
    expect(await log.load(claim(1))).toBeUndefined();
    expect((await log.load(claim(2)))?.response).toBeDefined();
  });

  it("counts retention from completion, not from the claim", async () => {
    let clock = 0;
    const log = createRetainingDacsWalletSpendOperationLogV1(1, 500, () => clock);
    expect(await log.claim(claim(1))).toBe("new");
    clock = 10_000;
    await log.complete(finish(claim(1)));
    clock = 10_499;
    expect(await log.claim(claim(2))).toBe("full");
    clock = 10_500;
    expect(await log.claim(claim(2))).toBe("new");
  });

  it("answers an exact repeat of a kept operation and refuses a changed one", async () => {
    const log = createRetainingDacsWalletSpendOperationLogV1(2);
    await log.claim(claim(1));
    expect(await log.claim(claim(1))).toBe("existing");
    await expect(log.claim(claim(1, "b"))).rejects.toMatchObject({
      reasonCode: "wallet-spend-authority-operation-conflict",
    });
    await log.complete(finish(claim(1)));
    await expect(log.complete({
      ...finish(claim(1)), response: { ok: "other" } as unknown as Complete["response"],
    })).rejects.toMatchObject({ reasonCode: "wallet-spend-authority-operation-conflict" });
  });

  it("refuses a limit that is not a positive integer", () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(() => createRetainingDacsWalletSpendOperationLogV1(limit)).toThrow(
        "wallet-spend-authority-operation-retention-invalid",
      );
    }
    for (const minRetainMs of [-1, 1.5, Number.NaN]) {
      expect(() => createRetainingDacsWalletSpendOperationLogV1(1, minRetainMs)).toThrow(
        "wallet-spend-authority-operation-retention-invalid",
      );
    }
  });
});
