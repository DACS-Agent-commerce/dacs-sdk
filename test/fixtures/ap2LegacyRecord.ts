import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalize } from "../../src/canonical/index.js";

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export interface MainFormatAp2Record {
  transactionId: string;
  jobId: string;
  phaseIndex: number;
  state?: "in-flight" | "settled" | "failed";
  payee?: string;
  amount?: string;
}

/**
 * Write one AP2 binding record exactly as the previous release's filesystem
 * store wrote it (`git show 527cd1b:src/rails/ap2SettlementFs.ts`): store
 * version 1, intent version "1" with no retained operation, no replay deadline,
 * and no `phases/` directory. The AP2-6 key is derived here the way that
 * release did (NFC of any non-empty job id), not through the current SDK.
 * Returns the record's path.
 */
export async function writeMainFormatAp2Record(dir: string, input: MainFormatAp2Record): Promise<string> {
  const jobId = input.jobId.normalize("NFC");
  const unsigned = {
    intentVersion: "1",
    transactionId: input.transactionId,
    jobId,
    phaseIndex: input.phaseIndex,
    agreementHash: "a".repeat(64),
    idempotencyKey: sha256(`dacs-ap2-idem:v1:${jobId}:${input.phaseIndex}`),
    mandateId: "mandate-1",
    payee: input.payee ?? "merchant-1",
    amount: input.amount ?? "10",
    currency: "USD",
    protocolVersion: "0.2",
    paymentInstrumentId: "pm_card_visa",
  };
  const intent = { ...unsigned, bindingHash: sha256(canonicalize(unsigned)) };
  const providerRef = "pi_legacy";
  const record = {
    storeVersion: 1,
    intent,
    lease: { owner: "main-worker", generation: 1, expiresAt: 110 },
    ...(input.state === "settled" ? {
      providerRef,
      settlement: {
        providerRef, mandateId: intent.mandateId, protocolVersion: intent.protocolVersion,
        payee: intent.payee, amount: intent.amount, currency: intent.currency, capturedAt: 105,
        receiptAttestation: {
          anchor: { kind: "https", locator: "https://provider.example/pi_legacy" },
          contentHash: "b".repeat(64),
        },
      },
    } : {}),
    ...(input.state === "failed" ? { failure: "declined" } : {}),
    createdAt: 100,
    updatedAt: 100,
  };
  await mkdir(join(dir, "records"), { recursive: true, mode: 0o700 });
  const path = join(dir, "records", `${sha256(input.transactionId)}.json`);
  await writeFile(path, JSON.stringify(record), { mode: 0o600 });
  return path;
}
