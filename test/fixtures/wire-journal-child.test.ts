import * as wireValidate from "../../src/wire/validate.js";
// A seller worker in its own process, for test/wire/requestJournal.test.ts. It
// binds, opens and checks the given signed requests against the shipped
// durable journal in the given directory, opened at startup as a seller host
// would, and handles each effect as a host must: a `new` effect runs (one
// line appended, and synced, to the effects log), a `recover` effect first
// reconciles against that log, then the outcome is recorded with
// completeWireEffect. It writes each verdict, in order. DACS_WIRE_JOURNAL_CRASH
// stops the worker for the parent to kill: `after-reserve` before its first
// effect runs, `after-effect` after it ran and before its outcome is recorded.
import { closeSync, constants, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as wire from "../../src/wire/index.js";
import { fixtureBinder } from "../wire/authorityFixture.js";
import { journalFixture } from "../wire/requestJournalFixture.js";

async function runJournalWorker(): Promise<void> {
    const { DACS_WIRE_JOURNAL_INPUT: inputPath, DACS_WIRE_JOURNAL_RESULT: resultPath, DACS_WIRE_JOURNAL_GO: go, DACS_WIRE_JOURNAL_CRASH: crash } = process.env;
    if (!inputPath || !resultPath) throw new Error("child worker configuration is missing");
    const input: unknown = JSON.parse(readFileSync(inputPath, "utf8"));
    if (!wireValidate.isRecord(input) || typeof input.journal !== "string" || !wireValidate.isUint(input.journalNow) || !wireValidate.isUint(input.now) ||
        !wireValidate.isClaim(input.seller) || !wireValidate.isListingPin(input.listingPin) || !Array.isArray(input.requests) || input.requests.length > 64 ||
        (input.leaseMs !== undefined && !wireValidate.isUint(input.leaseMs))) throw new Error("invalid journal worker fixture");
    const retained = input.retained;
    if (!wireValidate.hasKeys(retained, ["jobId", "agreementHash", "buyer", "seller"]) || typeof retained.jobId !== "string" ||
        !wireValidate.isHash(retained.agreementHash) || !wireValidate.isClaim(retained.buyer) || !wireValidate.isClaim(retained.seller)) throw new Error("invalid retained worker fixture");
    const kept = { jobId: retained.jobId, agreementHash: retained.agreementHash, buyer: retained.buyer, seller: retained.seller };
    const binding = await fixtureBinder(wire)({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: input.local });
    const context = { binding, local: binding.local, purchaseProfile: binding.profile };
    const journalNow = input.journalNow;
    const journal = journalFixture(wire).openJournal(input.journal, { leaseMs: input.leaseMs ?? 60_000, clock: () => journalNow });
    const log = join(input.journal, "..", "effects.log");
    const effects = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
    const runEffect = (operationId: string) => {
      const fd = openSync(log, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
      try { writeFileSync(fd, `${operationId}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    };
    // Opened before the start signal, so racing workers meet at the reservation.
    const opened = await Promise.all(input.requests.map(async (request: unknown) => {
      if (!wireValidate.isRecord(request) || typeof request.path !== "string" || typeof request.header !== "string" || typeof request.body !== "string") throw new Error("invalid worker request");
      return { path: request.path, body: request.body, envelope: await wire.openWireEnvelope(request.header, "request", context) };
    }));
    let completed = false;
    process.on("disconnect", () => { if (!completed) process.exit(1); });
    if (go) {
      writeFileSync(`${resultPath}.ready`, "");
      process.send?.("ready");
      await new Promise<void>((resolve, reject) => process.once("message", (message: unknown) => {
        if (message === "go") resolve(); else reject(new Error("invalid worker start signal"));
      }));
    }
    const verdicts: string[] = [];
    const finish = () => { writeFileSync(`${resultPath}.tmp`, JSON.stringify(verdicts)); renameSync(`${resultPath}.tmp`, resultPath); process.send?.("verdict"); };
    const hold = async () => { finish(); await new Promise<never>(() => {}); };
    for (const { path, body, envelope } of opened) {
      let effect: wire.WireEffect | null;
      try {
        effect = (await wire.checkWireRequest(envelope, { ...context, requestJournal: journal, seller: input.seller, listingPin: input.listingPin,
          method: "POST", path, rawBody: Buffer.from(body), now: input.now, retained: kept,
          commitment: Buffer.from(JSON.stringify(input.commitment)), agreement: Buffer.from(JSON.stringify(input.agreement)),
          signedListing: Buffer.from(JSON.stringify(input.signedListing)), readCommitmentReceipt: Object.assign(() => "valid", { chainIdentity: binding.profile.chainIdentity }) })).effect;
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
    completed = true;
    if (process.connected) process.disconnect();
}

if (process.env.DACS_WIRE_JOURNAL_STANDALONE === "1") await runJournalWorker();
else {
  const { it } = await import("vitest");
  it.skipIf(process.env.DACS_WIRE_JOURNAL_CHILD !== "1")("checks signed effects in a separate worker", runJournalWorker);
}
