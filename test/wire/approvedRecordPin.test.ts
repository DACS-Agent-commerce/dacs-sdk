// The SDK pins the approved testnet identity record dacs-demos-testnet-identity/2026-10-21.
// Every place that names the record, and every value derived from it, carries that identifier.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as wire from "../../src/wire/index.js";
import { canonicalize } from "../../src/canonical/index.js";
import { fixtureBinder } from "./authorityFixture.js";

const APPROVED_PIN = "dacs-demos-testnet-identity/2026-10-21";
const SUPERSEDED_PIN = "dacs-demos-testnet-identity/2026-10-20";
const RECORD = wire.TP1_APPROVED_IDENTITY_RECORD;
const LOCAL = { endpoint: "https://rpc-pin.identity.invalid/", transportAuthority: "test-pin", connectionId: "pin-1" };

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const digestOf = (record: unknown) => createHash("sha256").update(canonicalize(record)).digest("hex");
const bindFixture = fixtureBinder(wire);

/** The record as the superseded approval held it: only the record strings differ. */
const supersededRecord = () => ({
  ...RECORD,
  recordId: SUPERSEDED_PIN,
  pinVersion: SUPERSEDED_PIN,
  provenance: { ...RECORD.provenance, documentation: RECORD.provenance.documentation.replace(APPROVED_PIN, SUPERSEDED_PIN) },
});

describe("approved identity record pin", () => {
  it("exports the approved record id and pin version", () => {
    expect(RECORD.recordId).toBe(APPROVED_PIN);
    expect(RECORD.pinVersion).toBe(APPROVED_PIN);
  });

  it("carries the approved pin in the profile description of the network", () => {
    expect(wire.TESTNET_PROFILE_TP1.network.identityRecord).toBe(RECORD);
    expect(wire.TESTNET_PROFILE_TP1.network.identityRecord.pinVersion).toBe(APPROVED_PIN);
  });

  it("names the approved record, and no other, in the provenance documentation", () => {
    expect(RECORD.provenance.documentation).toContain(`\`${APPROVED_PIN}\``);
    expect(JSON.stringify(RECORD)).not.toContain(SUPERSEDED_PIN);
  });

  it("binds the signed profile tuple to the approved pin", async () => {
    const binding = await bindFixture({ record: structuredClone(RECORD), local: LOCAL });
    expect(binding.profile.pinVersion).toBe(APPROVED_PIN);
    expect(binding.profile.chainIdentity).toBe(RECORD.chainIdentity);
    expect(binding.recordDigest).toBe(digestOf(RECORD));
  });

  it("approves exactly the digest of the exported record", () => {
    expect(wire.TP1_APPROVED_IDENTITY_RECORD_DIGESTS).toEqual([digestOf(RECORD)]);
  });

  it("refuses the superseded record, which names the same chain under another pin", async () => {
    const superseded = supersededRecord();
    expect(superseded.chainIdentity).toBe(RECORD.chainIdentity);
    expect(wire.TP1_APPROVED_IDENTITY_RECORD_DIGESTS).not.toContain(digestOf(superseded));
    await expect(bindFixture({ record: superseded, local: LOCAL })).rejects.toMatchObject({ code: "tp1_identity_unapproved" });
  });

  it("refuses a record that keeps the approved record id under the superseded pin version", async () => {
    const mixed = { ...structuredClone(RECORD), pinVersion: SUPERSEDED_PIN };
    await expect(bindFixture({ record: mixed, local: LOCAL })).rejects.toMatchObject({ code: "tp1_identity_unapproved" });
  });
});

describe("published record pin", () => {
  const register: typeof import("../../conformance/tp1-register.json") = JSON.parse(read("conformance/tp1-register.json"));

  it("lists the exported record and its digest in the conformance register", () => {
    expect(register.network.record).toEqual(RECORD);
    expect(register.network.record.recordId).toBe(APPROVED_PIN);
    expect(register.network.record.pinVersion).toBe(APPROVED_PIN);
    expect(register.network.canonicalDigest).toBe(digestOf(RECORD));
  });

  it.each(["docs/testnet-profile-tp1.md", "docs/dacs-seller-http-v1.md"])("%s names the approved record and not the superseded one", (path) => {
    const text = read(path);
    expect(text).toContain(APPROVED_PIN);
    expect(text).not.toContain(SUPERSEDED_PIN);
  });

  it("states the approved record's digest in the profile document", () => {
    expect(read("docs/testnet-profile-tp1.md")).toContain(digestOf(RECORD));
  });

  it("names no superseded record in the shipped wire sources", () => {
    for (const path of ["src/wire/profile.ts", "src/wire/approval.ts"]) {
      expect(read(path), path).not.toContain(SUPERSEDED_PIN);
    }
  });
});
