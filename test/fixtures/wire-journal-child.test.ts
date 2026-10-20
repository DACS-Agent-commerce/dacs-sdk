// A seller worker in its own process, for test/wire/requestJournal.test.ts. It
// binds, opens and checks the given signed requests against a durable journal
// directory, qualified at startup as a seller host would, and writes each
// verdict, in order. Each request names its body and the seller's commitment.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { it } from "vitest";

import * as wire from "../../src/wire/index.js";
import { fixtureBinder } from "../wire/authorityFixture.js";
import { journalFixture } from "../wire/requestJournalFixture.js";

it.skipIf(process.env.DACS_WIRE_JOURNAL_CHILD !== "1")(
  "checks signed effect requests against a durable journal in its own process",
  async () => {
    const { DACS_WIRE_JOURNAL_INPUT: inputPath, DACS_WIRE_JOURNAL_RESULT: resultPath, DACS_WIRE_JOURNAL_GO: go } = process.env;
    if (!inputPath || !resultPath) throw new Error("child worker configuration is missing");
    const input = JSON.parse(readFileSync(inputPath, "utf8"));
    const binding = fixtureBinder(wire)({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: input.local });
    const context = { binding, local: input.local, purchaseProfile: binding.profile };
    const journal = journalFixture(wire).qualifiedDirectoryJournal(input.journal, input.now);
    // Opened before the start signal, so racing workers meet at the reservation.
    const opened = (input.requests as Array<{ path: string; header: string; body: string }>).map(({ path, header, body }) =>
      ({ path, body, envelope: wire.openWireEnvelope(header, "request", context) }));
    if (go) {
      writeFileSync(`${resultPath}.ready`, "");
      const deadline = Date.now() + 60_000;
      while (!existsSync(go)) {
        if (Date.now() > deadline) throw new Error("child worker got no start signal");
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }
    const verdicts = opened.map(({ path, body, envelope }) => {
      try {
        wire.checkWireRequest(envelope, { ...context, requestJournal: journal, seller: input.seller, listingPin: input.listingPin,
          method: "POST", path, rawBody: Buffer.from(body), now: input.now, retained: input.retained,
          commitment: input.commitment, readCommitmentReceipt: () => "valid" });
        return "ok";
      } catch (error) {
        if (error instanceof wire.WireError) return error.code;
        throw error;
      }
    });
    writeFileSync(`${resultPath}.tmp`, JSON.stringify(verdicts));
    renameSync(`${resultPath}.tmp`, resultPath);
    // The parent kills a holding worker here: a crash after the reservation, before any effect.
    if (process.env.DACS_WIRE_JOURNAL_HOLD === "1") await new Promise<never>(() => {});
  },
);
