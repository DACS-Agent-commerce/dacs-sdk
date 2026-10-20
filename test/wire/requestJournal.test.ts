import * as fixtureWire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";
import { inMemoryJournalForTest } from "./requestJournalFixture.js";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import * as wire from "../../src/wire/index.js";

const bindTp1Fixture = fixtureBinder(fixtureWire);
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
  const request = (path: string, nonce = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX"): wire.WireRequestPayload => ({
    version: "1", kind: "request", method: "POST", path, jobId: JOB, buyer: buyer.claim, seller: seller.claim, bodyHash: sha256Hex("{}"),
    listingPin: PIN, agreementHash: "a".repeat(64), nonce, expiresAt: NOW + 30_000, profile: binding.profile,
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
  const retained = { jobId: JOB, agreementHash: "a".repeat(64), buyer: buyer.claim, seller: seller.claim };
  // The seller is ready, so a route that starts a purchase reaches its reservation.
  const check = (path: string) => ({ ...context, seller: seller.claim, listingPin: PIN, method: "POST", path, rawBody: Buffer.from("{}"), now: NOW, retained, ready: true });
  return { seller, context, request, direct, delegated, artifact, retained, check };
}

describe("an effect route without a journal declared durable", () => {
  // Each differs from an accepted journal only in not declaring itself durable; none is ever called.
  const undeclared = (stub: () => boolean): Array<[string, object]> => [
    ["the earlier reserveRequest callback", { reserveRequest: stub }],
    ["a bare callback", { requestJournal: stub }],
    ["an in-memory set with no declaration", { requestJournal: { reserve: stub } }],
    ["durable: false", { requestJournal: { durable: false, reserve: stub } }],
    ['durable: "true"', { requestJournal: { durable: "true", reserve: stub } }],
    ["durable: 1", { requestJournal: { durable: 1, reserve: stub } }],
    ["a declaration with no reserve", { requestJournal: { durable: true, reserveRequest: stub } }],
  ];
  it.each(EFFECT_ROUTES)("%s refuses an in-memory stub unless a test opts in, direct and delegated", (path) => {
    const x = world();
    const journal = new Set<string>();
    const stub = vi.fn(() => { journal.add("reserved"); return true; });
    const opened = { direct: () => wire.openWireEnvelope(x.direct(x.request(path)), "request", x.context), delegated: () => x.delegated(x.request(path)) };
    for (const [mode, open] of Object.entries(opened)) {
      const check = { ...x.check(path), ...(mode === "delegated" ? { requireDelegation: true, artifacts: [x.artifact] } : {}) };
      for (const [name, given] of undeclared(stub)) {
        expect(() => wire.checkWireRequest(open(), { ...check, ...given } as wire.RequestCheck), `${mode}: ${name}`)
          .toThrowError(expect.objectContaining({ code: "seller_replay_guard_required", status: 500 }));
      }
      expect(stub).not.toHaveBeenCalled();
      expect(journal.size).toBe(0);
    }
    // Only the explicit test opt-in reaches the same stub.
    expect(wire.checkWireRequest(opened.direct(), { ...x.check(path), requestJournal: inMemoryJournalForTest(stub) })).toEqual({ body: {}, readbackOnly: false });
    expect(wire.checkWireRequest(opened.delegated(), { ...x.check(path), requireDelegation: true, artifacts: [x.artifact], requestJournal: inMemoryJournalForTest(stub) }).readbackOnly).toBe(false);
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("read routes need no journal", () => {
    const x = world();
    for (const path of [P.state, P.bundleBuyerCopy]) {
      expect(wire.checkWireRequest(wire.openWireEnvelope(x.direct(x.request(path)), "request", x.context), x.check(path)).readbackOnly).toBe(false);
    }
  });
});

describe("a durable journal across a restart and concurrent workers", () => {
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
  /** A journal directory and the signed requests a worker checks, with the seller's own record. */
  function prepare(x: ReturnType<typeof world>, lists: Record<string, wire.WireRequestPayload[]>) {
    const dir = mkdtempSync(join(tmpdir(), "dacs-wire-journal-"));
    scratch.push(dir);
    const inputs = Object.fromEntries(Object.entries(lists).map(([name, requests]) => {
      const path = join(dir, `${name}.input.json`);
      writeFileSync(path, JSON.stringify({ journal: dir, now: NOW, local: LOCAL, seller: x.seller.claim, listingPin: PIN, retained: x.retained,
        requests: requests.map((payload) => ({ path: payload.path, header: x.direct(payload) })) }));
      return [name, path];
    }));
    return { dir, inputs };
  }

  it("a repeated payment or delivery request is refused after the worker that reserved it is killed and another starts", async () => {
    const x = world();
    const { dir, inputs } = prepare(x, { requests: PAYMENT_AND_DELIVERY.map((path) => x.request(path, nonce())) });
    const first = worker(inputs.requests!, join(dir, "first.json"), { DACS_WIRE_JOURNAL_HOLD: "1" });
    await appears(join(dir, "first.json"), first);
    expect(first.verdicts()).toEqual(["ok", "ok"]);
    // Killed after its reservations and before any effect, as a crash.
    process.kill(-first.child.pid!, "SIGKILL");
    await first.exited;
    const restarted = worker(inputs.requests!, join(dir, "restarted.json"));
    expect(await restarted.exited, restarted.output()).toBe(0);
    expect(restarted.verdicts()).toEqual(["peer_request_replayed", "peer_request_replayed"]);
  }, 120_000);

  it("of two workers checking the same payment and delivery requests at once, exactly one accepts each", async () => {
    const x = world();
    const requests = Array.from({ length: 16 }, () => PAYMENT_AND_DELIVERY.map((path) => x.request(path, nonce()))).flat();
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
    for (const [i, verdict] of forward.entries()) expect([verdict, backward[i]].sort()).toEqual(["ok", "peer_request_replayed"]);
  }, 120_000);
});
