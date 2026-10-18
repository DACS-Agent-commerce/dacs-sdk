import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { admitArtifactJson, snapshotAdmittedArtifact, cloneWithArtifactAdmission, inheritArtifactAdmission, canonicalize, contentHash, encodeAddressSegment } from "../../src/canonical/index.js";
import { createInMemoryBindingStore, createScanningArtifactRepository, resolveAndRead } from "../../src/discovery/index.js";
import { DemosAdapter } from "../../src/substrate/DemosAdapter.js";
import { publicKeyFromRaw, verifyArtifact } from "../../src/crypto/index.js";
import { verifySettlementEvidence, verifyLegacySettlementEvidence } from "../../src/agent/verifySettlementEvidence.js";

const read = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
const vectors = read("../../vendor/DACS-Standard/conformance/vectors/security/presence-only-claim-requirement-v0.7.json");
const original = vectors.vectors[0].compositeRecord;
const owner = original.signature.signer;
const logicalAddress = `dacs2:composite:${original.jobId}:${encodeAddressSegment(original.evaluatedParty)}`;
const nativeAddress = "public-offline-fixture";
const binding = { owner, logicalAddress, nativeAddress, contentHash: contentHash(original) };

function repository(bytes: Uint8Array, parsed?: Record<string, unknown>) {
  const adapter = new DemosAdapter({ rpc: "https://offline.test" });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes as BodyInit)));
  // Keep the earlier parsed SDK transport viable: a transport failure must not
  // satisfy a CF-5 rejection assertion when these tests run before the fix.
  vi.spyOn(adapter.raw.storagePrograms, "read").mockImplementation(async () =>
    JSON.parse(Buffer.from(bytes).toString("utf8")) as never);
  const store = createInMemoryBindingStore([binding]);
  const verify = vi.fn((record: Record<string, any>) =>
    record.recordVersion === "1" && record.jobId === original.jobId &&
    record.evaluatedParty === original.evaluatedParty && record.signature.signer === owner &&
    verifyArtifact("dacs-composite:v1:", record, Buffer.from(record.signature.value, "base64url"),
      publicKeyFromRaw(Buffer.from(vectors.publicKeys.verifier, "hex"))));
  const repo = createScanningArtifactRepository({
    adapter: {
      getAddress: () => owner,
      anchorWriteOnce: async () => { throw new Error("unexpected write"); },
      readAnchor: parsed ? async () => parsed : (address) => adapter.readAnchor(address),
    },
    expectedOwner: owner, index: store, publisher: store, verifyArtifact: verify,
    fetchPage: async () => ({ entries: [{ owner, logicalAddress, nativeAddress }], nextCursor: null }),
  });
  return { repo, verify, adapter };
}
const envelope = (raw: string) => Buffer.from(`{"success":true,"storageAddress":"${nativeAddress}","data":${raw}}`);
afterEach(() => vi.unstubAllGlobals());

describe("CF-5 through Demos transport and scanning repository", () => {
  test("admits exact artifact bytes and verifies the upstream public signature", async () => {
    const { repo, verify } = repository(envelope(JSON.stringify(original)));
    const result = await repo.scanPage();
    expect(result.results[0]?.outcome).toMatchObject({ status: "verified", record: original });
    expect(verify).toHaveBeenCalledOnce();
  });

  test("rejects duplicate raw artifact members before hashing or verification", async () => {
    const raw = '{"overallDecision":"fail",' + JSON.stringify(original).slice(1);
    const { repo, verify, adapter } = repository(envelope(raw));
    await expect(adapter.readAnchor(nativeAddress)).rejects.toMatchObject({
      cause: { stage: "profile", code: "DUPLICATE-MEMBER" },
    });
    const result = await repo.scanPage();
    expect(result.results[0]?.outcome.status).toBe("indeterminate");
    expect(verify).not.toHaveBeenCalled();
  });

  test("rejects pre-rounding out-of-profile numbers at discovery ingress", async () => {
    const raw = JSON.stringify(original).replace(/"evaluatedAt":\s*\d+/, '"evaluatedAt":9007199254740991.1');
    // Use a new member if this corpus version names its timestamp differently.
    const input = raw === JSON.stringify(original)
      ? '{"rawNumber":9007199254740991.1,' + raw.slice(1) : raw;
    const { repo, verify, adapter } = repository(envelope(input));
    await expect(adapter.readAnchor(nativeAddress)).rejects.toMatchObject({
      cause: { stage: "profile", code: "NUMBER-OUTSIDE-DACS-MAGNITUDE" },
    });
    expect((await repo.scanPage()).results[0]?.outcome.status).toBe("indeterminate");
    expect(verify).not.toHaveBeenCalled();
  });

  test("refuses a lossy parsed external object even with a genuine signature", async () => {
    const { repo, verify } = repository(new Uint8Array(), structuredClone(original));
    expect((await repo.scanPage()).results[0]?.outcome.status).toBe("indeterminate");
    expect(verify).not.toHaveBeenCalled();
  });

  const corpus = read("../fixtures/standard-next/raw-json-profile-v0.1.json");
  for (const vector of corpus.vectors.filter((v: any) => v.expected === "reject")) {
    test(`raw corpus at actual adapter ingress: ${vector.name}`, async () => {
      const bytes = vector.rawHex === undefined
        ? Buffer.from(vector.rawUtf8Text) : Buffer.from(vector.rawHex, "hex");
      const { adapter, verify } = repository(bytes);
      await expect(adapter.readAnchor(nativeAddress)).rejects.toMatchObject({
        cause: { stage: vector.expectedStage, code: vector.expectedErrorCode },
      });
      expect(verify).not.toHaveBeenCalled();
    });
  }

  for (const vector of corpus.vectors.filter((v: any) => v.expected === "accept")) {
    test(`accepted raw corpus reaches envelope validation: ${vector.name}`, async () => {
      const bytes = vector.rawHex === undefined
        ? Buffer.from(vector.rawUtf8Text) : Buffer.from(vector.rawHex, "hex");
      const { adapter } = repository(bytes);
      // These arbitrary JSON corpus values are not storage response envelopes.
      // They pass CF-5, then fail the separate application shape requirement.
      try {
        await adapter.readAnchor(nativeAddress);
        throw new Error("expected an invalid storage envelope");
      } catch (error) {
        const cause = (error as Error).cause;
        expect(cause).toBeInstanceOf(Error);
        expect(cause).not.toHaveProperty("stage");
        expect(cause).not.toHaveProperty("code");
      }
    });
  }

  test("preserves nested admission through owned envelope and handshake snapshots", () => {
    const envelope = admitArtifactJson(Buffer.from(JSON.stringify({ payload: { evidence: original } })));
    const canonical = JSON.parse(canonicalize(envelope));
    inheritArtifactAdmission(envelope, canonical);
    const request = cloneWithArtifactAdmission({ evidence: canonical.payload.evidence });
    expect(snapshotAdmittedArtifact(request.evidence)).toEqual(original);
    expect(() => snapshotAdmittedArtifact(structuredClone(request.evidence))).toThrow(/raw-byte admission/);
  });

  test("snapshot helpers cannot grant provenance to unproven parsed input", () => {
    const unproven = structuredClone(original);
    const snapshot = cloneWithArtifactAdmission({ evidence: unproven });
    inheritArtifactAdmission(unproven, snapshot.evidence);
    expect(() => snapshotAdmittedArtifact(snapshot.evidence)).toThrow(/raw-byte admission/);
  });

  test("snapshot helpers reject changed admitted transport or artifact values", () => {
    const envelope = admitArtifactJson(Buffer.from(JSON.stringify({ payload: { evidence: original } })));
    const changed = structuredClone(envelope);
    changed.extra = true;
    expect(() => inheritArtifactAdmission(envelope, changed)).toThrow(/snapshot changed/);
    envelope.extra = true;
    expect(() => cloneWithArtifactAdmission(envelope)).toThrow(/changed after raw-byte admission/);
  });

  test("transport projection cannot admit an inherited object member", () => {
    expect(() => admitArtifactJson(Buffer.from("{}"), "__proto__")).toThrow(/member is missing/);
  });

  test.each(["mutation", "clone"])("a %s cannot manufacture admission provenance", async (kind) => {
    const admitted = admitArtifactJson(Buffer.from(JSON.stringify(original)));
    const input = kind === "clone" ? structuredClone(admitted) : admitted;
    const { repo, verify } = repository(new Uint8Array(), input);
    if (kind === "mutation") admitted.overallDecision = "fail";
    expect((await repo.scanPage()).results[0]?.outcome.status).toBe("indeterminate");
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("current payment verification ingress and archival inspection", () => {
  const fixture = read("../../vendor/DACS-Standard/conformance/fixtures/settlement-evidence-payment-success.json");
  const ctx = {
    orchestrator: "did:demos:orchestrator", agreement: { amount: "5", currency: "USDC" },
    rail: { railId: "polygon-amoy-usdc", railType: "evm-erc20", asset: "USDC", network: "eip155:80002", handler: "pay-evm-erc20" },
    attestationRef: fixture.result.attestationRef,
    paymentAddress: { railId: "polygon-amoy-usdc", phaseIndex: 0 },
    result: { ok: true, txRefs: fixture.result.txRefs },
  };
  test("rejects a cryptographically valid legacy fixture under the current profile before dependencies are invoked", async () => {
    const deps = { resolvePublicKey: vi.fn(), verify: vi.fn() };
    const record = admitArtifactJson(Buffer.from(JSON.stringify(fixture.evidence)));
    expect(await verifySettlementEvidence(record, ctx, deps)).toEqual({
      decision: "error", reasons: ["jobId must be a JID-1 canonical ULID"],
    });
    expect(deps.resolvePublicKey).not.toHaveBeenCalled();
    expect(deps.verify).not.toHaveBeenCalled();
    const { ed25519Verify } = await import("../../src/crypto/index.js");
    expect((await verifyLegacySettlementEvidence(fixture.evidence, ctx, {
      resolvePublicKey: async (signer) => Buffer.from(fixture.publicKeys[signer], "base64url"),
      verify: (bytes, sig, key) => ed25519Verify(bytes, sig, publicKeyFromRaw(key)),
    })).decision).toBe("pass");
  });
  test("archival signature inspection remains explicit while current candidate refuses", async () => {
    const jobId = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
    const evidence = { ...fixture.evidence, jobId };
    const record = admitArtifactJson(Buffer.from(JSON.stringify(evidence)));
    const deps = {
      resolvePublicKey: vi.fn(async () => new Uint8Array(32)),
      verify: vi.fn(() => true),
    };
    const context = {
      ...ctx,
      attestationRef: {
        anchor: { kind: "storage-program" as const, locator: `dacs4:payment:${jobId}:polygon-amoy-usdc:0` },
        contentHash: contentHash(record),
      },
    };
    expect(await verifyLegacySettlementEvidence(record, context, deps)).toEqual({ decision: "pass", reasons: [] });
    expect((await verifySettlementEvidence(record, context, deps)).decision).toBe("error");
    expect(deps.resolvePublicKey).toHaveBeenCalledOnce();
    expect(deps.verify).toHaveBeenCalledOnce();
  });
  test("parsed duplicate payment fields never get authenticated", async () => {
    const current = { ...fixture.evidence, jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D" };
    const raw = '{"outcome":"failure",' + JSON.stringify(current).slice(1);
    const deps = { resolvePublicKey: vi.fn(), verify: vi.fn() };
    expect(() => admitArtifactJson(Buffer.from(raw))).toThrow(/DUPLICATE-MEMBER/);
    expect((await verifySettlementEvidence(JSON.parse(raw), ctx, deps)).decision).toBe("error");
    expect(deps.resolvePublicKey).not.toHaveBeenCalled();
    expect(deps.verify).not.toHaveBeenCalled();
  });
});


test("CF-5 negative zero survives adapter and verified-read snapshots without normalizing wire keys", async () => {
  const raw = '{"n":-0,"nested":[-0],"wire:é":"é"}';
  const record = { n: 0, nested: [0], "wire:é": "é" };
  const { adapter } = repository(envelope(raw));
  const admitted = await adapter.readAnchor(nativeAddress);
  expect(snapshotAdmittedArtifact(admitted)).toEqual(record);
  expect(Object.is(admitted!.n, -0)).toBe(false);
  const index = createInMemoryBindingStore([{ ...binding, contentHash: contentHash(record) }]);
  const verify = vi.fn(() => true);
  expect(await resolveAndRead(index, logicalAddress, owner, {
    read: (address) => adapter.readAnchor(address), contentHashOf: contentHash, verifySignature: verify,
  })).toMatchObject({ status: "verified", record });
  expect(verify).toHaveBeenCalledOnce();
  expect(() => snapshotAdmittedArtifact(JSON.parse(raw))).toThrow(/raw-byte admission/);
});


test.each(["swapped-native-slot", undefined])("public storage rejects mismatched or absent returned native address %s", async (storageAddress) => {
  const bytes = Buffer.from(JSON.stringify({ success: true, storageAddress, data: original }));
  const { adapter, verify } = repository(bytes);
  await expect(adapter.readAnchor(nativeAddress)).rejects.toMatchObject({
    cause: { message: "storage response address does not match requested anchor" },
  });
  expect(verify).not.toHaveBeenCalled();
});
