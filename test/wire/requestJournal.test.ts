import * as fixtureWire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";
import { journalFixture } from "./requestJournalFixture.js";
import { signedAgreement, validReceipt, wireCommitment } from "./commitmentFixture.js";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import * as wire from "../../src/wire/index.js";

const bindTp1Fixture = fixtureBinder(fixtureWire);
const { testJournals, openJournal } = journalFixture(fixtureWire);
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const NOW = Date.UTC(2026, 9, 18);
const JOB = "01K7FZ8Q9W3V5T2R1N0M8K6J4H";
const LOCAL = { endpoint: "https://rpc.journal.invalid/", transportAuthority: "test", connectionId: "1" };
const PIN = { listingId: "report", version: 1, contentHash: "c".repeat(64) };
const P = wire.DACS_SELLER_HTTP_PATHS;
const EFFECT_ROUTES = wire.DACS_SELLER_HTTP_ROUTES.filter((r) => r.auth === "signed" && r.effect === "effect").map((r) => r.path);
const PAYMENT_AND_DELIVERY = [P.payments, P.bundleRequest] as const;
function party() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  return { claim: `did:demos:agent:${key}`, key, sign: (bytes: Uint8Array) => sign(null, Buffer.from(bytes), privateKey) };
}
const header = (value: unknown) => Buffer.from(canonicalize(value)).toString("base64url");
/** A fresh request nonce: the reservation key is shared across routes, so each request needs its own. */
const nonce = () => randomBytes(24).toString("base64url");
function world() {
  const buyer = party(), seller = party(), session = party();
  const binding = bindTp1Fixture({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: LOCAL });
  const context = { binding, local: LOCAL, purchaseProfile: binding.profile };
  const { agreement, agreementHash } = signedAgreement({ buyer, seller, jobId: JOB, listingPin: PIN });
  const request = (path: string, nonce = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX", body = "{}"): wire.WireRequestPayload => ({
    version: "1", kind: "request", method: "POST", path, jobId: JOB, buyer: buyer.claim, seller: seller.claim, bodyHash: sha256Hex(body),
    listingPin: PIN, agreementHash, nonce, expiresAt: NOW + 30_000, profile: binding.profile,
  });
  const signed = (payload: unknown, signer: ReturnType<typeof party>, domain: string) => ({ payload, signature: signer.sign(Buffer.from(domain + canonicalize(payload))).toString("base64url") });
  /** The buyer-signed (undelegated) request header. */
  const direct = (payload: wire.WireRequestPayload) => header(signed(payload, buyer, wire.DACS_SELLER_HTTP_DOMAINS.request));
  const delegated = (payload: wire.WireRequestPayload) => {
    const delegation = signed({ version: "1", kind: "seller-session-delegation", buyer: buyer.claim, seller: seller.claim,
      sessionPublicKey: session.key, listingPin: PIN, jobId: JOB, notBefore: NOW - 1000, expiresAt: NOW + 60_000,
      profile: binding.profile }, buyer, wire.DACS_SELLER_HTTP_DOMAINS.delegation);
    return wire.openWireEnvelope(header({ ...signed(payload, session, wire.DACS_SELLER_HTTP_DOMAINS.request), delegation }), "request", { ...context, requireDelegation: true });
  };
  const artifact = { jobId: JOB, listingRef: PIN, parties: [{ role: "buyer", primaryClaim: buyer.claim }, { role: "seller", primaryClaim: seller.claim }], terms: { deadline: NOW + 60_000 } };
  /** What the seller host retained for the job: its own record, not read from the request. */
  const retained = { jobId: JOB, agreementHash, buyer: buyer.claim, seller: seller.claim };
  /** The job's finalized commitment and its signed Agreement, which the seller read itself: payment and delivery routes need them. */
  const commitment = wireCommitment({ seller, buyer: buyer.claim, jobId: JOB, agreementHash, listingPin: PIN, committedAt: NOW - 5000 });
  // The seller is ready, so a route that starts a purchase reaches its reservation.
  const check = (path: string) => ({ ...context, seller: seller.claim, listingPin: PIN, method: "POST", path, rawBody: Buffer.from("{}"), now: NOW, retained, ready: true,
    commitment, agreement, readCommitmentReceipt: validReceipt });
  return { seller, context, agreement, request, direct, delegated, artifact, retained, commitment, check };
}

describe("an effect route without the SDK's journal", () => {
  // None came from openWireRequestJournal, a journal that declares itself durable included; none is ever called.
  const undeclared = (stub: () => boolean): Array<[string, object]> => [
    ["the earlier reserveRequest callback", { reserveRequest: stub }],
    ["a bare callback", { requestJournal: stub }],
    ["an in-memory set with no declaration", { requestJournal: { reserve: stub } }],
    ["durable: false", { requestJournal: { durable: false, reserve: stub } }],
    ['durable: "true"', { requestJournal: { durable: "true", reserve: stub } }],
    ["a declaration with no reserve", { requestJournal: { durable: true, reserveRequest: stub } }],
    ["a journal that declares itself durable", { requestJournal: { durable: true, reserve: stub } }],
    ["the earlier qualified handle's shape", { requestJournal: { qualified: true } }],
  ];
  it.each(EFFECT_ROUTES)("%s refuses any other journal, direct and delegated", (path) => {
    const x = world();
    const calls: string[] = [];
    const stub = () => { calls.push("reserved"); return true; };
    const opened = { direct: () => wire.openWireEnvelope(x.direct(x.request(path, nonce())), "request", x.context), delegated: () => x.delegated(x.request(path, nonce())) };
    for (const [mode, open] of Object.entries(opened)) {
      const check = { ...x.check(path), ...(mode === "delegated" ? { requireDelegation: true, artifacts: [x.artifact] } : {}) };
      for (const [name, given] of undeclared(stub)) {
        expect(() => wire.checkWireRequest(open(), { ...check, ...given } as wire.RequestCheck), `${mode}: ${name}`)
          .toThrowError(expect.objectContaining({ code: "seller_replay_guard_required", status: 500 }));
      }
    }
    expect(calls).toEqual([]);
    // Only the SDK's own journal reserves.
    const journals = testJournals();
    expect(wire.checkWireRequest(opened.direct(), { ...x.check(path), requestJournal: journals.open() })).toEqual({ body: {}, readbackOnly: false, effect: expect.objectContaining({ state: "new" }) });
    expect(wire.checkWireRequest(opened.delegated(), { ...x.check(path), requireDelegation: true, artifacts: [x.artifact], requestJournal: journals.open() }).readbackOnly).toBe(false);
    expect(journals.reservations()).toHaveLength(2);
  });

  it("read routes need no journal and have no effect", () => {
    const x = world();
    for (const path of [P.state, P.bundleBuyerCopy]) {
      expect(wire.checkWireRequest(wire.openWireEnvelope(x.direct(x.request(path)), "request", x.context), x.check(path))).toEqual({ body: {}, readbackOnly: false, effect: null });
    }
  });
});

describe("the durable journal across a restart and concurrent workers", () => {
  const scratch: string[] = [];
  afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  /** Each worker is its own Node process (a nested Vitest run of test/fixtures/wire-journal-child.test.ts). */
  function worker(input: string, result: string, env: Record<string, string> = {}) {
    const child = spawn(process.execPath, [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "test/fixtures/wire-journal-child.test.ts", "--pool=forks", "--maxWorkers=1", "--reporter=dot"], {
      cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DACS_WIRE_JOURNAL_CHILD: "1", DACS_WIRE_JOURNAL_INPUT: input, DACS_WIRE_JOURNAL_RESULT: result, ...env },
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    const exited = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
    const verdicts = () => JSON.parse(readFileSync(result, "utf8")) as string[];
    return { child, exited, verdicts, output: () => output };
  }
  async function appears(path: string, of: ReturnType<typeof worker>) {
    const deadline = Date.now() + 60_000;
    while (!existsSync(path)) {
      if (Date.now() > deadline || of.child.exitCode !== null) throw new Error(`worker did not write ${path}\n${of.output()}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  async function killed(of: ReturnType<typeof worker>) {
    process.kill(-of.child.pid!, "SIGKILL");
    await of.exited;
  }
  /** A journal directory, its effects log, and the signed requests a worker checks, with the seller's own record. */
  function prepare(x: ReturnType<typeof world>, lists: Record<string, Array<{ payload: wire.WireRequestPayload; body: string }>>, leaseMs?: number) {
    const dir = mkdtempSync(join(tmpdir(), "dacs-wire-journal-"));
    scratch.push(dir);
    const journal = join(dir, "journal");
    mkdirSync(journal, { mode: 0o700 });
    const inputs = Object.fromEntries(Object.entries(lists).map(([name, requests]) => {
      const path = join(dir, `${name}.input.json`);
      writeFileSync(path, JSON.stringify({ journal, leaseMs, now: NOW, local: LOCAL, seller: x.seller.claim, listingPin: PIN, retained: x.retained, commitment: x.commitment, agreement: x.agreement,
        requests: requests.map(({ payload, body }) => ({ path: payload.path, header: x.direct(payload), body })) }));
      return [name, path];
    }));
    const effects = () => (existsSync(join(dir, "effects.log")) ? readFileSync(join(dir, "effects.log"), "utf8").split("\n").filter(Boolean) : []);
    return { dir, inputs, effects };
  }
  /** Payment and delivery for the job, each signed again with a fresh nonce and other incidental body fields. */
  const effectRequests = (x: ReturnType<typeof world>, note: string) => PAYMENT_AND_DELIVERY.map((path) => {
    const body = JSON.stringify({ note });
    return { payload: x.request(path, nonce(), body), body };
  });
  const operations = (x: ReturnType<typeof world>) => PAYMENT_AND_DELIVERY.map((path) => wire.wireOperationId(x.request(path))).sort();

  it.each(["after-reserve", "after-effect"] as const)("a worker killed %s: its replacement recovers, and payment and delivery each run exactly once", async (crash) => {
    const x = world();
    const leaseMs = 1000;
    const { dir, inputs, effects } = prepare(x, { first: effectRequests(x, "first"), retry: effectRequests(x, "retry"), again: effectRequests(x, "again") }, leaseMs);
    const first = worker(inputs.first!, join(dir, "first.json"), { DACS_WIRE_JOURNAL_CRASH: crash });
    await appears(join(dir, "first.json"), first);
    expect(first.verdicts()).toEqual(["new"]);
    await killed(first);
    expect(effects()).toHaveLength(crash === "after-effect" ? 1 : 0);
    // Restarted after the dead attempt's lease: each operation is recovered once, reconciled against the effects log.
    await new Promise((resolve) => setTimeout(resolve, leaseMs + 100));
    const restarted = worker(inputs.retry!, join(dir, "retry.json"));
    expect(await restarted.exited, restarted.output()).toBe(0);
    expect(restarted.verdicts()).toEqual(crash === "after-effect" ? ["reconciled", "new"] : ["recover", "new"]);
    // A later repeat, with yet another nonce and body, is answered with the kept outcome.
    const again = worker(inputs.again!, join(dir, "again.json"));
    expect(await again.exited, again.output()).toBe(0);
    expect(again.verdicts()).toEqual(PAYMENT_AND_DELIVERY.map((path) => `completed:${JSON.stringify({ effect: wire.wireOperationId(x.request(path)) })}`));
    expect([...effects()].sort()).toEqual(operations(x));
  }, 120_000);

  it("a worker killed while it holds the lease leaves the operation pending, never run twice, until the lease ends", async () => {
    const x = world();
    const { dir, inputs, effects } = prepare(x, { first: effectRequests(x, "first"), retry: effectRequests(x, "retry") }, 60_000);
    const first = worker(inputs.first!, join(dir, "first.json"), { DACS_WIRE_JOURNAL_CRASH: "after-reserve" });
    await appears(join(dir, "first.json"), first);
    await killed(first);
    const restarted = worker(inputs.retry!, join(dir, "retry.json"));
    expect(await restarted.exited, restarted.output()).toBe(0);
    expect(restarted.verdicts()).toEqual(["seller_effect_pending", "new"]);
    expect(effects()).toEqual([wire.wireOperationId(x.request(P.bundleRequest))]);
  }, 120_000);

  it("of two workers checking the same signed requests at once, exactly one accepts each", async () => {
    const x = world();
    // Each its own job route would share an operation, so each request is its own route-and-nonce pair: the race is on each one's key.
    const requests = Array.from({ length: 8 }, () => PAYMENT_AND_DELIVERY.map((path) => ({ payload: x.request(path, nonce()), body: "{}" }))).flat();
    // The two workers take the requests in opposite orders, so they meet partway.
    const { dir, inputs } = prepare(x, { forward: requests, backward: [...requests].reverse() });
    const go = join(dir, "go");
    const a = worker(inputs.forward!, join(dir, "a.json"), { DACS_WIRE_JOURNAL_GO: go });
    const b = worker(inputs.backward!, join(dir, "b.json"), { DACS_WIRE_JOURNAL_GO: go });
    await Promise.all([appears(join(dir, "a.json.ready"), a), appears(join(dir, "b.json.ready"), b)]);
    writeFileSync(go, "");
    expect(await a.exited, a.output()).toBe(0);
    expect(await b.exited, b.output()).toBe(0);
    const forward = a.verdicts(), backward = b.verdicts().reverse();
    expect(forward).toHaveLength(requests.length);
    for (const [i, verdict] of forward.entries()) expect([verdict, backward[i]], `request ${i}`).toContain("peer_request_replayed");
  }, 120_000);

  it("of two workers racing on the same payment and delivery with their own nonces, exactly one runs each effect", async () => {
    const x = world();
    const { dir, inputs, effects } = prepare(x, { a: effectRequests(x, "a"), b: effectRequests(x, "b").reverse() });
    const go = join(dir, "go");
    const a = worker(inputs.a!, join(dir, "a.json"), { DACS_WIRE_JOURNAL_GO: go });
    const b = worker(inputs.b!, join(dir, "b.json"), { DACS_WIRE_JOURNAL_GO: go });
    await Promise.all([appears(join(dir, "a.json.ready"), a), appears(join(dir, "b.json.ready"), b)]);
    writeFileSync(go, "");
    expect(await a.exited, a.output()).toBe(0);
    expect(await b.exited, b.output()).toBe(0);
    const verdicts = [...a.verdicts(), ...b.verdicts()];
    expect(verdicts.filter((v) => v === "new")).toHaveLength(2);
    expect(verdicts.every((v) => v === "new" || v === "seller_effect_pending" || v.startsWith("completed:"))).toBe(true);
    expect([...effects()].sort()).toEqual(operations(x));
  }, 120_000);
});

describe("the durable journal keyed by operation across a reopen", () => {
  it("a fresh nonce for an effect another handle reserved is held; the effect completes only on its own handle, and a reopened journal answers with the outcome", () => {
    const x = world();
    const directory = mkdtempSync(join(tmpdir(), "dacs-wire-operation-"));
    try {
      const check = (path: string, journal: wire.WireRequestJournal) => wire.checkWireRequest(wire.openWireEnvelope(x.direct(x.request(path, nonce())), "request", x.context),
        { ...x.check(path), requestJournal: journal });
      const issuer = openJournal(directory);
      const effects = PAYMENT_AND_DELIVERY.map((path) => check(path, issuer).effect!);
      for (const effect of effects) expect(effect.state).toBe("new");
      // A second journal handle over the same directory stands for another or restarted worker.
      const other = openJournal(directory);
      for (const path of PAYMENT_AND_DELIVERY) expect(() => check(path, other)).toThrowError(expect.objectContaining({ code: "seller_effect_pending", status: 503 }));
      expect(() => wire.completeWireEffect(other, effects[0]!, { status: 200, text: "0" })).toThrowError(expect.objectContaining({ code: "wire_input_invalid", detail: "EFFECT-NOT-ISSUED" }));
      effects.forEach((effect, i) => wire.completeWireEffect(issuer, effect, { status: 200, text: `${i}` }));
      PAYMENT_AND_DELIVERY.forEach((path, i) => expect(check(path, openJournal(directory)).effect).toMatchObject({ state: "completed", outcome: { status: 200, text: `${i}` } }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
