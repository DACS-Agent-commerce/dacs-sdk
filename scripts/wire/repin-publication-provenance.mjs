#!/usr/bin/env node
// Re-pin descriptive provenance after publication redactions. Captured wire
// messages stay unchanged; the revision adapter re-signs the same cases with
// fresh test keys. Run after editing text, then build and run test/wire/.
//
// Usage: node scripts/wire/repin-publication-provenance.mjs [--previous-ref HEAD]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize } from "../../dist/canonical/index.js";
import { sha256Hex, writeJson } from "./fixture-helpers.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const argv = process.argv.slice(2);
if (argv.length && (argv.length !== 2 || argv[0] !== "--previous-ref")) throw new Error("expected --previous-ref <ref>");
const previous = argv[1] ?? "HEAD";
const path = (name) => join(root, name);
const read = (name) => readFileSync(path(name), "utf8");
const digest = (value) => sha256Hex(canonicalize(value));
const hashFile = (name) => sha256Hex(readFileSync(path(name)));
const edit = (name, fn) => writeFileSync(path(name), fn(read(name)));
const fixtures = "test/wire/fixtures";
const originalName = `${fixtures}/plugin-wire-82bf8c4.original.json`;
const preRevisionName = `${fixtures}/plugin-wire-82bf8c4.tp1-adapted.json`;
const revisionName = `${fixtures}/plugin-wire-82bf8c4.tp1-revision-adapted.json`;
const captureName = "scripts/wire/capture-plugin-wire-fixture.mjs";
const adapterName = "scripts/wire/adapt-tp1-revision-fixture.mjs";

const original = JSON.parse(read(originalName));
const generator = original.provenance.generator;
generator.captureSha256 ??= generator.sha256;
generator.sha256 = hashFile(captureName);
original.immutable = "Captured messages are immutable. Publication metadata is re-pinned; the test suite pins the file's SHA-256.";
original.publicationNote = "Generator text redacted for publication on 2026-10-18; captured messages and source citations are unchanged. captureSha256 records the generator used for the capture.";
writeJson(path(originalName), original);

const preRevision = JSON.parse(read(preRevisionName));
preRevision.derivedFrom.sha256 = hashFile(originalName);
preRevision.syntheticIdentityRecord.digest = digest(preRevision.syntheticIdentityRecord.record);
preRevision.publicationNote = "Descriptive provenance redacted for publication on 2026-10-18; captured messages and recorded outcomes are unchanged.";
writeJson(path(preRevisionName), preRevision);

// Binding vectors carry record digests outside their signed wire messages.
const vectorsName = "vectors/dacs-seller-http-v1.json";
const before = JSON.parse(execFileSync("git", ["show", `${previous}:${vectorsName}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 }));
const vectors = JSON.parse(read(vectorsName));
const recordDigests = new Map();
function collect(old, current) {
  if (old === null || typeof old !== "object") return;
  if (old.format === "dacs-testnet-identity-record/v1") recordDigests.set(digest(old), digest(current));
  for (const key of Object.keys(old)) collect(old[key], current[key]);
}
collect(before, vectors);
function refresh(value) {
  if (typeof value === "string") return recordDigests.get(value) ?? value;
  if (Array.isArray(value)) return value.map(refresh);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, refresh(v)]));
  return value;
}
writeJson(path(vectorsName), refresh(vectors));

const registerName = "conformance/tp1-register.json";
const register = JSON.parse(read(registerName));
const oldApproval = register.network.canonicalDigest;
const newApproval = digest(register.network.record);
for (const name of [registerName, "src/wire/approval.ts", "test/wire/approvedIdentity.test.ts", "test/wire/builtPackage.test.ts", "test/wire/wire.test.ts", "docs/testnet-profile-tp1.md"]) {
  edit(name, (text) => text.replaceAll(oldApproval, newApproval));
}

const originalHash = hashFile(originalName);
const preRevisionHash = hashFile(preRevisionName);
edit(adapterName, (text) => text
  .replace(/(const ORIGINAL = .*sha256: ")[0-9a-f]{64}/, `$1${originalHash}`)
  .replace(/(const ADAPTED = .*sha256: ")[0-9a-f]{64}/, `$1${preRevisionHash}`));
const scratch = mkdtempSync(join(tmpdir(), "dacs-publication-"));
try {
  const generated = join(scratch, "revision.json");
  execFileSync(process.execPath, [path(adapterName), "--sdk-dist", path("dist"), "--fixtures", path(fixtures), "--out", generated], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  writeFileSync(path(revisionName), readFileSync(generated));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
const pins = { ORIGINAL: originalHash, PRE_REVISION: preRevisionHash, ADAPTED: hashFile(revisionName), ADAPTER: hashFile(adapterName) };
edit("test/wire/originalFixture.test.ts", (text) => {
  for (const [name, hash] of Object.entries(pins)) text = text.replace(new RegExp(`(const ${name}_SHA256 = ")[0-9a-f]{64}`), `$1${hash}`);
  return text;
});
console.log(JSON.stringify({ approval: newApproval, fixturePins: pins, captureGenerator: hashFile(captureName), syntheticRecords: recordDigests.size }, null, 2));
