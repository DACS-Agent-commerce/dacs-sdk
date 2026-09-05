import { readFile, writeFile } from "node:fs/promises";

import { it } from "vitest";

import {
  createWalletSpendAuthorityV1,
  type WalletSpendPolicyV1,
  type WalletSpendReservationV1,
} from "../../src/rails/walletSpendAuthority.js";
import { createFsWalletSpendStateStoreV1 } from "../../src/rails/walletSpendAuthorityFs.js";

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

it.skipIf(process.env.DACS_WALLET_SPEND_CHILD !== "1")(
  "reserves through a real independent wallet-spend process",
  async () => {
    const dir = process.env.DACS_WALLET_SPEND_DIR;
    const ready = process.env.DACS_WALLET_SPEND_READY;
    const start = process.env.DACS_WALLET_SPEND_START;
    const output = process.env.DACS_WALLET_SPEND_OUTPUT;
    const reservationId = process.env.DACS_WALLET_SPEND_RESERVATION;
    if (!dir || !ready || !start || !output || !reservationId) {
      throw new Error("wallet spend child configuration is missing");
    }
    const key = Buffer.from(process.env.DACS_WALLET_SPEND_KEY ?? "", "hex");
    const policy: WalletSpendPolicyV1 = {
      policyVersion: "1",
      policyId: "child-policy",
      wallet: "child-wallet",
      chainId: "demos:testnet",
      maximumConcurrentEffects: 1,
      maximumRetainedReservations: 10,
      assets: [{
        asset: "DEM-OS",
        maximumPerOrderDebit: "100",
        maximumNetworkFeeDebit: "10",
        minimumReserve: "100",
        rollingWindowMs: 86_400_000,
        maximumRollingEffects: 10,
        maximumRollingDebit: "1000",
        maximumCumulativeDebit: "1000",
        maximumCounterpartyDebit: "1000",
      }],
    };
    const store = await createFsWalletSpendStateStoreV1({ dir, integrityKey: key });
    const authority = createWalletSpendAuthorityV1(policy, {
      store,
      readBalance: async () => "1000",
      authenticateRecovery: async () => true,
      owner: `child-${reservationId}`,
      now: () => 1_000,
    });
    const reservation: WalletSpendReservationV1 = {
      reservationVersion: "1",
      reservationId,
      jobId: `job-${reservationId}`,
      phaseIndex: 0,
      phase: "pay-dem",
      agreementHash: "a".repeat(64),
      settlementBindingHash: "c".repeat(64),
      railId: "pay-dem",
      railDefinitionHash: "b".repeat(64),
      wallet: "child-wallet",
      chainId: "demos:testnet",
      payee: "seller",
      finality: { model: "bft-final" },
      debits: [{
        asset: "DEM-OS",
        purpose: "service",
        expectedAmount: "90",
        maximumAmount: "90",
      }],
    };
    await writeFile(ready, String(process.pid), { mode: 0o600 });
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        await readFile(start, "utf8");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (Date.now() >= deadline) throw new Error("wallet spend child start timed out");
        await wait(5);
      }
    }
    const claim = await authority.reserve(reservation);
    await writeFile(output, JSON.stringify({
      status: claim.status,
      ...(claim.status === "denied" ? { reason: claim.reason } : {}),
    }), { mode: 0o600 });
  },
  15_000,
);
