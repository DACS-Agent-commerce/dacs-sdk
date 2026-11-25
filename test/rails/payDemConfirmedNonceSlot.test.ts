import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { payDemConfirmedNonceSlot } from "../../src/rails/payDem.js";

// Raw `getTxByHash` envelopes read from node2; the `response` member is the record.
const node2 = JSON.parse(readFileSync(
  new URL("../fixtures/demos-node2-records.json", import.meta.url),
  "utf8",
)) as { getTxByHash: Record<string, { response: Record<string, unknown> }> };

const PAYER = "c0a58599ceaeba18f9c450133631cce4c45f4dc7a59c8026331504da3a913c2a";
const PAYEE = "706b89f5e2d56498a90bc3a209842b0bd0e22ce06bb4df7c27805e655614e5f1";
const CONFIRMED_HASH = "330dcf1dac0839ebc138d5e2a0db6db7b9567d769c8d4bd987b0d72d7d905918";
const FAILED_HASH = "85b8fcdcee48822742a39e1b9877f5e2f8dde36430e8e486e3a8b0c9a7744cbd";
const SELLER = "ab".repeat(32);

interface Edit { type: string; operation: string; isRollback?: boolean; account: unknown; amount: unknown }
interface RecordShape {
  hash: string;
  status: string;
  blockNumber: number;
  content: {
    type: string;
    from: unknown;
    from_ed25519_address: unknown;
    to: unknown;
    nonce: string;
    data: [string, { nativeOperation: string; args: [unknown, unknown] }];
    gcr_edits: Edit[];
  };
}

const recordOf = (hash: string): RecordShape =>
  structuredClone(node2.getTxByHash[hash]!.response) as unknown as RecordShape;

const CONFIRMED_BLOCK = recordOf(CONFIRMED_HASH).blockNumber;
const SLOT = Object.freeze({
  txHash: CONFIRMED_HASH, nonce: 28, blockNumber: CONFIRMED_BLOCK, payer: PAYER, payee: PAYEE,
});

/** The confirmed record rewritten as a 1 DEM transfer from the payer to itself. */
function selfTransfer(): RecordShape {
  const record = recordOf(CONFIRMED_HASH);
  record.content.to = `0x${PAYER}`;
  record.content.data[1].args = [PAYER, "1000000000"];
  record.content.gcr_edits = record.content.gcr_edits
    .filter((edit) => edit.account === `0x${PAYER}`)
    .map((edit) => (edit.type === "balance" && edit.amount === "9500000000" ? { ...edit, amount: "1000000000" } : edit));
  return record;
}

describe("the confirmed transaction that took a pay-dem nonce", () => {
  it("classifies the confirmed transaction that took a nonce", () => {
    // (a) The recorded transfer pays its own payee, and nothing to another account.
    expect(payDemConfirmedNonceSlot(recordOf(CONFIRMED_HASH), SLOT)).toBe("pays-payee");
    expect(payDemConfirmedNonceSlot(recordOf(CONFIRMED_HASH), { ...SLOT, payee: SELLER })).toBe("other");

    // (b) A self-transfer pays the seller nothing, and pays the payer only.
    expect(payDemConfirmedNonceSlot(selfTransfer(), { ...SLOT, payee: SELLER })).toBe("other");
    expect(payDemConfirmedNonceSlot(selfTransfer(), { ...SLOT, payee: PAYEE })).toBe("other");

    // (d) A record that credits the payee only through an execution edit still pays the payee.
    const throughEdit = selfTransfer();
    throughEdit.content.type = "crosschainOperation";
    throughEdit.content.gcr_edits.push({
      type: "balance", operation: "add", isRollback: false, account: `0x${SELLER}`, amount: "1",
    });
    expect(payDemConfirmedNonceSlot(throughEdit, { ...SLOT, payee: SELLER })).toBe("pays-payee");
  });

  it("refuses a nonce slot record it cannot bind", () => {
    const failed = recordOf(FAILED_HASH);
    expect(payDemConfirmedNonceSlot(failed, { ...SLOT, txHash: FAILED_HASH, nonce: 9 })).toBeNull();

    for (const change of [
      { txHash: "11".repeat(32) }, { nonce: 29 }, { payer: SELLER }, { blockNumber: CONFIRMED_BLOCK + 1 },
    ]) {
      expect(payDemConfirmedNonceSlot(recordOf(CONFIRMED_HASH), { ...SLOT, ...change })).toBeNull();
    }

    const refusedRecords: Array<(record: RecordShape) => void> = [
      (record) => { record.content.from_ed25519_address = `0x${SELLER}`; },
      (record) => {
        const content: Partial<RecordShape["content"]> = record.content;
        delete content.from;
        delete content.from_ed25519_address;
      },
      (record) => { record.status = "pending"; },
      (record) => { delete (record as Partial<RecordShape>).blockNumber; },
      (record) => { (record as { blockNumber: unknown }).blockNumber = String(record.blockNumber + 1); },
      (record) => { record.content.data[1].args[0] = 42; },
      (record) => { record.content.gcr_edits[0]!.account = "not-an-account"; },
      (record) => {
        record.content.gcr_edits.push(...Array.from({ length: 300 }, () => ({
          type: "nonce", operation: "add", account: `0x${SELLER}`, amount: 1,
        })));
      },
    ];
    for (const change of refusedRecords) {
      const record = recordOf(CONFIRMED_HASH);
      change(record);
      expect(payDemConfirmedNonceSlot(record, { ...SLOT, payee: SELLER })).toBeNull();
    }
  });
});
