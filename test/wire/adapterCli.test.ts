import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import { envelopeSignatureBytes, verifyEd25519 } from "../../src/wire/validate.js";
import { captureRecord, parseCapture } from "./captureFixture.js";

const fixtureDir = resolve("test/wire/fixtures");
const inputNames = ["plugin-wire-82bf8c4.original.json", "plugin-wire-82bf8c4.tp1-adapted.json"];
const dirs: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "wire-adapter-cli-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const run = (out: string, fixtures = fixtureDir) => spawnSync(process.execPath,
  [resolve("scripts/wire/adapt-tp1-revision-fixture.mjs"), "--sdk-dist", resolve("dist"), "--fixtures", fixtures, "--out", out],
  { encoding: "utf8", timeout: 30_000 });
const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const decode = (header: string) => captureRecord(JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as unknown);
const domains = { request: "dacs-seller-http:v1:request:", response: "dacs-seller-http:v1:response:", delegation: "dacs-seller-http:v1:delegation:" };

it("generates a signed revision adaptation and refuses a repeat without changing its bytes", () => {
  const out = join(scratch(), "revision.json"), result = run(out);
  expect(result.status, result.stderr).toBe(0);
  const generated = parseCapture(read(out), "revision");
  const previous = parseCapture(read(join(fixtureDir, inputNames[1] ?? "")), "pre-revision");
  expect(generated.job).toEqual(previous.job);
  expect(generated.now).toBe(previous.now);
  expect(generated.localBindings).toEqual(previous.localBindings);
  expect(generated.syntheticIdentityRecord).toEqual(previous.syntheticIdentityRecord);
  const restore = new Map<string, string>();
  for (const role of ["buyer", "seller", "session", "other"] as const) {
    expect(generated.parties[role]).not.toBe(previous.parties[role]);
    expect(generated.keySubstitution.parties[role]).toEqual({ from: previous.parties[role], to: generated.parties[role] });
    restore.set(generated.parties[role], previous.parties[role]);
    restore.set(generated.parties[role].slice(-64), previous.parties[role].slice(-64));
  }
  const undo = (value: unknown): unknown => typeof value === "string" ? restore.get(value) ?? value
    : Array.isArray(value) ? value.map(undo) : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "revision").map(([key, v]) => [key, key === "requestHash" ? null : undo(v)])) : value;
  const verify = (payload: unknown, signature: unknown, claim: string, domain: string, fixed = false) => {
    expect(verifyEd25519(Buffer.from(fixed ? "x" : domain + canonicalize(payload)), envelopeSignatureBytes(signature), claim.slice(-64))).toBe(true);
  };
  const header = (text: string, oldText: string, signer: string, fixed = false) => {
    const envelope = decode(text), old = decode(oldText), payload = captureRecord(envelope.payload);
    expect(captureRecord(payload.profile).revision).toBe("TP-1");
    expect(undo(payload)).toEqual(undo(old.payload));
    const domain = payload.kind === "response" ? domains.response : domains.request;
    verify(payload, envelope.signature, signer, domain, fixed);
    if (envelope.delegation) {
      const d = captureRecord(envelope.delegation);
      verify(d.payload, d.signature, generated.parties.buyer, domains.delegation);
    }
    expect(Buffer.from(canonicalize(envelope)).toString("base64url")).toBe(text);
  };
  for (const name of ["request", "response", "delegatedRequest"] as const) {
    const signer = name === "response" ? generated.parties.seller : name === "delegatedRequest" ? generated.parties.session : generated.parties.buyer;
    header(generated.valid[name].header, previous.valid[name].header, signer);
  }
  expect(generated.valid.response.payload.requestHash).toBe(sha256Hex(canonicalize(generated.valid.response.request)));
  verify(generated.valid.delegation.payload, generated.valid.delegation.signature, generated.parties.buyer, domains.delegation);
  for (const c of generated.requestNegatives) {
    const old = previous.requestNegatives.find(p => p.id === c.id);
    if (!old) throw new Error(`missing source case ${c.id}`);
    const signer = c.id === "request/wrong-signer" ? generated.parties.other : c.id === "request/delegated-outlives-delegation" ? generated.parties.session : generated.parties.buyer;
    header(c.header, old.header, signer, ["request/extra-field", "request/bad-nonce"].includes(c.id));
  }
  for (const c of generated.responseNegatives) {
    const old = previous.responseNegatives.find(p => p.id === c.id);
    if (!old) throw new Error(`missing source case ${c.id}`);
    header(c.header, old.header, c.id === "response/other-signer" ? generated.parties.other : generated.parties.seller);
  }
  for (const c of generated.delegationNegatives) {
    const payload = c.id === "delegation/lifetime-over-24h" ? generated.valid.delegation.payload : c.delegation.payload;
    verify(payload, c.delegation.signature, c.id === "delegation/bad-signature" ? generated.parties.other : generated.parties.buyer, domains.delegation);
  }
  for (const key of ["requestNegatives", "delegationNegatives", "responseNegatives"] as const) {
    expect(generated[key].map(c => c.id)).toEqual(previous[key].map(c => c.id));
  }
  const bytes = readFileSync(out);
  const repeat = run(out);
  expect(repeat.status).not.toBe(0);
  expect(repeat.stderr).toContain("EEXIST");
  expect(readFileSync(out)).toEqual(bytes);
});
it.each(inputNames)("refuses tampered pinned input %s before writing output", name => {
  const dir = scratch(), inputs = join(dir, "inputs"), out = join(dir, "revision.json");
  mkdirSync(inputs);
  for (const file of inputNames) copyFileSync(join(fixtureDir, file), join(inputs, file));
  writeFileSync(join(inputs, name), Buffer.concat([readFileSync(join(inputs, name)), Buffer.from("\n")]));
  const result = run(out, inputs);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("is not the pinned file");
  expect(existsSync(out)).toBe(false);
});
