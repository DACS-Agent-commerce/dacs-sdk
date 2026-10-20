// A seller worker in its own process, for test/wire/requestJournal.test.ts. It
// binds, opens and checks the given signed requests against the shipped
// durable journal in the given directory, opened at startup as a seller host
// would, and handles each effect as a host must: a `new` effect runs (one
// line appended, and synced, to the effects log), a `recover` effect first
// reconciles against that log, then the outcome is recorded with
// completeWireEffect. It writes each verdict, in order. DACS_WIRE_JOURNAL_CRASH
// stops the worker for the parent to kill: `after-reserve` before its first
// effect runs, `after-effect` after it ran and before its outcome is recorded.
import { closeSync, constants, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

import { it } from "vitest";

import * as wire from "../../src/wire/index.js";
import { fixtureBinder } from "../wire/authorityFixture.js";
import { journalFixture } from "../wire/requestJournalFixture.js";

it.skipIf(process.env.DACS_WIRE_JOURNAL_CHILD !== "1")(
  "checks signed effect requests against a durable journal in its own process",
  async () => {
    const { DACS_WIRE_JOURNAL_INPUT: inputPath, DACS_WIRE_JOURNAL_RESULT: resultPath, DACS_WIRE_JOURNAL_GO: go, DACS_WIRE_JOURNAL_CRASH: crash } = process.env;
    if (!inputPath || !resultPath) throw new Error("child worker configuration is missing");
    const input = JSON.parse(readFileSync(inputPath, "utf8"));
    const binding = fixtureBinder(wire)({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: input.local });
    const context = { binding, local: input.local, purchaseProfile: binding.profile };
    const journal = journalFixture(wire).openJournal(input.journal, { leaseMs: input.leaseMs ?? 60_000 });
    const log = join(input.journal, "..", "effects.log");
    const effects = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
    const runEffect = (operationId: string) => {
      const fd = openSync(log, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
      try { writeSync(fd, `${operationId}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    };
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
    const verdicts: string[] = [];
    const finish = () => { writeFileSync(`${resultPath}.tmp`, JSON.stringify(verdicts)); renameSync(`${resultPath}.tmp`, resultPath); };
    const hold = async () => { finish(); await new Promise<never>(() => {}); };
    for (const { path, body, envelope } of opened) {
      let effect: wire.WireEffect | null;
      try {
        effect = wire.checkWireRequest(envelope, { ...context, requestJournal: journal, seller: input.seller, listingPin: input.listingPin,
          method: "POST", path, rawBody: Buffer.from(body), now: input.now, retained: input.retained,
          commitment: input.commitment, agreement: input.agreement, readCommitmentReceipt: () => "valid" }).effect;
      } catch (error) {
        if (error instanceof wire.WireError) { verdicts.push(error.code); continue; }
        throw error;
      }
      if (effect === null) throw new Error("an effect route returned no effect");
      if (effect.state === "completed") { verdicts.push(`completed:${effect.outcome.text}`); continue; }
      if (crash === "after-reserve") { verdicts.push(effect.state); await hold(); }
      // Recovering: an earlier attempt may have acted. The effect's own log is the source of truth.
      const done = effect.state === "recover" && effects().includes(effect.operationId);
      if (!done) runEffect(effect.operationId);
      if (crash === "after-effect") { verdicts.push(effect.state); await hold(); }
      wire.completeWireEffect(journal, effect, { status: 200, text: JSON.stringify({ effect: effect.operationId }) });
      verdicts.push(done ? "reconciled" : effect.state);
    }
    finish();
  },
);
