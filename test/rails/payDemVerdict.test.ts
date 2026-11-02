import { expect, it, vi } from "vitest";
import { createIdempotencyStore, createInMemorySettlementLog } from "../../src/rails/idempotency.js";
import { payDemSettle, payDemSettleCore, type PayDemRailResult } from "../../src/rails/payDem.js";

vi.mock("../../src/rails/payDemExecutionAuthority.js", () => ({
  createPayDemExecutionAuthority: () => ({
    assertCapability() {},
    hasVerdict: () => false,
    register: <T extends object>(value: T) => value,
    attest: <T extends object>(value: T) => value,
  }),
}));

const payer = "11".repeat(32);
const payee = "22".repeat(32);
const txHash = "ab".repeat(32);

it.each([true, false])("refuses a fresh definitive ok=%s result without a record verdict before writing", async (ok) => {
  const log = createInMemorySettlementLog();
  const write = vi.spyOn(log, "putOutcome");
  const result: PayDemRailResult = ok
    ? { ok: true, execution: "executed", txHash, chainId: "demos", payer, payee,
        blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" } }
    : { ok: false, txHash, chainId: "demos", payer, payee,
        blockNumber: 42, txRefKind: "demos", errorClass: "permanent",
        failureProof: { kind: "demos-failed-record", txHash, payer, payee,
          nonce: 9, blockNumber: 42, amountOs: "1000000000" } };
  const settle = payDemSettle({ address: payer, settle: async () => result }, {}, {
    store: createIdempotencyStore(log),
  });
  await expect(settle({ rail: "pay-dem", phase: "pay-dem", amount: "1", asset: "DEM",
    payee: `did:demos:agent:${payee}`, expectedPayee: payee,
    jobId: "unattested-verdict", phaseIndex: 0 })).rejects.toThrow(/SDK-owned record verdict/);
  expect(write).not.toHaveBeenCalled();
});

it("refuses an executed client response without an SDK record verdict", async () => {
  await expect(payDemSettleCore({ recipient: payee, amount: "1000000000" }, {
    address: payer,
    transfer: async () => ({ ok: true, hash: txHash, state: "included",
      execution: "executed", blockNumber: 42 }),
  })).rejects.toThrow(/SDK-owned record verdict/);
});
