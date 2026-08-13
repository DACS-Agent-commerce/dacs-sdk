import { writeFile } from "node:fs/promises";

import { it } from "vitest";

import { createFsDemosWriteJournal } from "../../src/substrate/demosWriteJournalFs.js";

it.skipIf(process.env.DACS_DEMOS_JOURNAL_CHILD !== "1")(
  "holds a real cross-process Demos journal lease until killed",
  async () => {
    const dir = process.env.DACS_DEMOS_JOURNAL_DIR;
    const ready = process.env.DACS_DEMOS_JOURNAL_READY;
    if (!dir || !ready) throw new Error("child journal configuration is missing");
    const journal = await createFsDemosWriteJournal({ dir });
    const lease = await journal.acquire({
      chainIdentity: "genesis-child",
      wallet: "0xchild",
    });
    await lease.put({
      writeId: "child-write",
      generation: lease.generation,
      kind: "immutable",
      operation: "create",
      stage: "broadcast-intent",
      logicalName: "dacs:child:v1",
      programName: "dacs-child-v1",
      owner: "0xchild",
      nativeAddress: "stor-child",
      valueHash: "child-value-hash",
      nonce: 1,
      txRef: "tx-child",
      signedTransaction: '{"hash":"tx-child"}',
      signedTransactionHash: "child-signed-hash",
      updatedAt: Date.now(),
    });
    await writeFile(ready, String(process.pid));
    await new Promise<never>(() => {});
  },
);
