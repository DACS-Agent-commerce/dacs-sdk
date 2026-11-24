import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { payDemConfirmedTotalDebitOs } from "../../src/rails/payDem.js";

// Raw `getTxByHash` envelopes read from node2; the `response` member is the record.
const node2 = JSON.parse(readFileSync(
  new URL("../fixtures/demos-node2-records.json", import.meta.url),
  "utf8",
)) as { getTxByHash: Record<string, { response: Record<string, unknown> }> };

const PAYER = "c0a58599ceaeba18f9c450133631cce4c45f4dc7a59c8026331504da3a913c2a";
const PAYEE = "706b89f5e2d56498a90bc3a209842b0bd0e22ce06bb4df7c27805e655614e5f1";
const CONFIRMED_HASH = "330dcf1dac0839ebc138d5e2a0db6db7b9567d769c8d4bd987b0d72d7d905918";
const FAILED_HASH = "85b8fcdcee48822742a39e1b9877f5e2f8dde36430e8e486e3a8b0c9a7744cbd";
const OTHER_ACCOUNT = "ab".repeat(32);

interface Edit { type: string; operation: string; isRollback?: boolean; account: string; amount: unknown }
interface RecordShape {
  hash: string;
  status: string;
  blockNumber: number;
  content: {
    type: string;
    amount: unknown;
    nonce: string;
    to: string;
    data: [string, { nativeOperation: string; args: [string, unknown] }];
    gcr_edits: Edit[];
  };
}

const recordOf = (hash: string): RecordShape =>
  structuredClone(node2.getTxByHash[hash]!.response) as unknown as RecordShape;

const CONFIRMED = Object.freeze({
  txHash: CONFIRMED_HASH,
  nonce: 28,
  blockNumber: 498_447,
  payer: PAYER,
  payee: PAYEE,
  amountOs: "9500000000",
});

/** The confirmed record rewritten to another amount, in the post-fork (OS string) or pre-fork (DEM number) form. */
function recordWithAmount(dem: number, postFork: boolean): RecordShape {
  const record = recordOf(CONFIRMED_HASH);
  const os = (BigInt(dem) * 1_000_000_000n).toString();
  const wire = (value: number, osValue: string) => (postFork ? osValue : value);
  record.content.amount = postFork ? Number(os) : dem;
  record.content.data[1].args[1] = wire(dem, os);
  for (const edit of record.content.gcr_edits) {
    if (edit.type !== "balance") continue;
    edit.amount = edit.amount === "1000000000" ? wire(1, "1000000000") : wire(dem, os);
  }
  return record;
}

describe("the real total debit of a confirmed pay-dem record", () => {
  it("returns the real total debit of a confirmed native send from its balance edits", () => {
    expect(payDemConfirmedTotalDebitOs(recordOf(CONFIRMED_HASH), CONFIRMED)).toBe("10500000000");

    // The recorded amount is not a whole DEM, so the pre-fork form uses 9 DEM in both forms.
    const nineDem = { ...CONFIRMED, amountOs: "9000000000" };
    expect(payDemConfirmedTotalDebitOs(recordWithAmount(9, true), nineDem)).toBe("10000000000");
    expect(payDemConfirmedTotalDebitOs(recordWithAmount(9, false), nineDem)).toBe("10000000000");
  });

  it("refuses a record it cannot bind", () => {
    const failed = recordOf(FAILED_HASH);
    expect(payDemConfirmedTotalDebitOs(failed, {
      ...CONFIRMED, txHash: FAILED_HASH, nonce: 9, blockNumber: failed.blockNumber,
    })).toBeNull();

    const refusedExpectations = [
      { txHash: "11".repeat(32) },
      { nonce: 29 },
      { blockNumber: 498_448 },
      { payee: OTHER_ACCOUNT },
      { amountOs: "9500000001" },
    ];
    for (const change of refusedExpectations) {
      expect(payDemConfirmedTotalDebitOs(recordOf(CONFIRMED_HASH), { ...CONFIRMED, ...change })).toBeNull();
    }

    const refusedRecords: Array<(record: RecordShape) => void> = [
      (record) => { record.content.gcr_edits[2]!.isRollback = true; },
      (record) => {
        record.content.gcr_edits.push({
          type: "balance", operation: "add", isRollback: false, account: `0x${PAYER}`, amount: "1",
        });
      },
      (record) => { record.content.type = "crosschainOperation"; },
      (record) => { record.content.data[1].args[1] = null; },
      (record) => {
        record.content.gcr_edits.push(...Array.from({ length: 300 }, () => ({
          type: "nonce", operation: "add", account: `0x${OTHER_ACCOUNT}`, amount: 1,
        })));
      },
    ];
    for (const change of refusedRecords) {
      const record = recordOf(CONFIRMED_HASH);
      change(record);
      expect(payDemConfirmedTotalDebitOs(record, CONFIRMED)).toBeNull();
    }
  });
});
