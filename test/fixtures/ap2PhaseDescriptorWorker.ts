import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import { deriveAp2IdempotencyKey } from "../../src/rails/ap2.js";
import { createFsAp2BindingStore } from "../../src/rails/ap2SettlementFs.js";

// Retain handles to prevent GC's fallback close from hiding a missing close().
const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
const originalOpen = fs.open;
fs.open = (async (...args: Parameters<typeof fs.open>) => {
  const handle = await originalOpen(...args);
  handles.push(handle);
  return handle;
}) as typeof fs.open;
syncBuiltinESMExports();

const dir = process.argv[2]!;
const store = await createFsAp2BindingStore({ dir });
const jobId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
for (let phaseIndex = 0; phaseIndex < 96; phaseIndex++) {
  const unsigned = {
    intentVersion: "2" as const, operationJson: "{}", operationHash: sha256Hex("{}"),
    transactionId: `descriptor-${phaseIndex}`, jobId, phaseIndex,
    idempotencyKey: deriveAp2IdempotencyKey(jobId, phaseIndex), agreementHash: "a".repeat(64),
    mandateId: "mandate", payee: "merchant", amount: "1", currency: "USD", protocolVersion: "0.2", paymentInstrumentId: "pm-test",
  };
  const result = await store.claim({ intent: { ...unsigned, bindingHash: sha256Hex(canonicalize(unsigned)) },
    owner: "descriptor-probe", now: 100, leaseDurationMs: 10, noReferenceReplayWindowMs: 1000 });
  assert.equal(result.status, "acquired");
}
assert.equal((await fs.readdir(`${dir}/phases`)).length, 96);
assert.ok(handles.length > 96);
assert.ok(handles.every((handle) => handle.fd === -1), "a durable phase write left its handle open");
process.stdout.write(JSON.stringify({ phases: 96, allHandlesClosed: true }));
