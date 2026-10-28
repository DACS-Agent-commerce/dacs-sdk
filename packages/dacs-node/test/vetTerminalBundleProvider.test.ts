import { describe, expect, test, vi } from "vitest";

import { attestationBundleHash } from "@kynesyslabs/dacs";

import { createVetTerminalBundleProvider } from "../src/vetTerminalBundleProvider.js";

const LOGICAL = "dacs5:bundle:vet-terminal-job:buyer";
const BUNDLE = { bundleVersion: "1", jobId: "vet-terminal-job", outcome: "failure" } as never;
const HASH = attestationBundleHash(BUNDLE);
const RECEIPT = { state: "finalized", logicalAddress: LOGICAL } as never;

function harness(overrides: Record<string, unknown> = {}) {
  const publication = {
    resolveRoleBundle: vi.fn(async () => ({
      bundle: BUNDLE,
      nativeAddress: "stor-native",
      anchorReceipt: RECEIPT,
      anchorTx: "tx-1",
    })),
    submitRoleBundle: vi.fn(async () => undefined),
    verifyBundleAnchorReceipt: vi.fn(async () => "valid" as const),
    resolveBundleBinding: vi.fn(async () => ({ disposition: "absent" as const })),
    publishRoleBundleBinding: vi.fn(async () => ({ disposition: "published" as const })),
    verifyBundleBinding: vi.fn(async () => "valid" as const),
    ...overrides,
  };
  const conflictFenced = vi.fn(async <T>(callback: () => Promise<T> | T) => await callback());
  const provider = createVetTerminalBundleProvider({
    role: "buyer",
    publication: publication as never,
    assertNoPlanConflict: async () => undefined,
    conflictFenced: conflictFenced as never,
    refuse: (reason) => new Error(`refused: ${reason}`),
  });
  return { provider, publication, conflictFenced };
}

const own = { role: "buyer" as const, logicalAddress: LOGICAL, bundleContentHash: HASH };

describe("Vet terminal bundle provider: retry versus permanent per read", () => {
  test("returns this role's finalized copy with its transaction", async () => {
    const { provider } = harness();
    await expect(provider.resolveOwnBundle(own)).resolves.toEqual({
      disposition: "present",
      value: {
        role: "buyer",
        logicalAddress: LOGICAL,
        nativeAddress: "stor-native",
        bundleContentHash: HASH,
        bundle: BUNDLE,
        anchorReceipt: RECEIPT,
        anchorTx: "tx-1",
      },
    });
  });

  test("omits a transaction the copy does not carry", async () => {
    const { provider } = harness({
      resolveRoleBundle: vi.fn(async () => ({
        bundle: BUNDLE, nativeAddress: "stor-native", anchorReceipt: RECEIPT,
      })),
    });
    const resolved = await provider.resolveOwnBundle(own);
    expect(resolved.disposition).toBe("present");
    expect(Object.keys((resolved as { value: object }).value)).not.toContain("anchorTx");
  });

  const resolutions: Array<[string, object, (() => unknown) | undefined, object]> = [
    ["the other role", { ...own, role: "seller" as const }, undefined,
      { disposition: "rejected", reason: "vet-terminal-bundle-role-mismatch" }],
    ["a read that throws a non-DacsError", own, (): never => { throw new TypeError("fetch failed"); },
      { disposition: "indeterminate", reason: "vet-terminal-bundle-resolution-unavailable" }],
    ["a read that throws an Error", own, (): never => { throw new Error("node down"); },
      { disposition: "indeterminate", reason: "vet-terminal-bundle-resolution-unavailable" }],
    ["no copy", own, async () => null,
      { disposition: "authoritatively-absent", reason: "vet-terminal-bundle-absent" }],
    ["a copy not finalized yet", own, async () => ({
      bundle: BUNDLE, nativeAddress: "stor-native",
      anchorReceipt: { state: "included", logicalAddress: LOGICAL },
    }), { disposition: "indeterminate", reason: "vet-terminal-bundle-finality-pending" }],
    ["a copy at another logical address", own, async () => ({
      bundle: BUNDLE, nativeAddress: "stor-native",
      anchorReceipt: { state: "finalized", logicalAddress: `${LOGICAL}:other` },
    }), { disposition: "rejected", reason: "vet-terminal-bundle-conflict" }],
    ["a different bundle", { ...own, bundleContentHash: "0".repeat(64) }, undefined,
      { disposition: "rejected", reason: "vet-terminal-bundle-conflict" }],
  ];
  test.each(resolutions)("classifies own-bundle resolution of %s", async (_label, input, read, expected) => {
    const { provider } = harness(read === undefined ? {} : { resolveRoleBundle: vi.fn(read) });
    await expect(provider.resolveOwnBundle(input as never)).resolves.toEqual(expected);
  });

  test.each([
    ["valid", { disposition: "valid" }],
    ["invalid", { disposition: "invalid", reason: "vet-terminal-bundle-publication-invalid" }],
    ["indeterminate",
      { disposition: "indeterminate", reason: "vet-terminal-bundle-publication-indeterminate" }],
    ["error", { disposition: "indeterminate", reason: "vet-terminal-bundle-publication-indeterminate" }],
  ] as const)("classifies a publication receipt verdict of %s", async (verdict, expected) => {
    const verifyBundleAnchorReceipt = vi.fn(async () => verdict);
    const { provider } = harness({ verifyBundleAnchorReceipt });
    const input = {
      role: "buyer" as const, bundle: BUNDLE, nativeAddress: "stor-native",
      anchorReceipt: RECEIPT, anchorTx: "tx-1",
    };
    await expect(provider.verifyOwnBundlePublication(input as never)).resolves.toEqual(expected);
    expect(verifyBundleAnchorReceipt).toHaveBeenCalledWith({
      bundle: BUNDLE, nativeAddress: "stor-native", anchorReceipt: RECEIPT, anchorTx: "tx-1",
    });
  });

  test("passes no transaction to receipt verification when the copy has none", async () => {
    const { provider, publication } = harness();
    await provider.verifyOwnBundlePublication({
      role: "buyer", bundle: BUNDLE, nativeAddress: "stor-native", anchorReceipt: RECEIPT,
    } as never);
    const [call] = vi.mocked(publication.verifyBundleAnchorReceipt).mock.calls[0] as unknown as [object];
    expect(Object.keys(call))
      .not.toContain("anchorTx");
  });

  test("refuses to verify or submit a copy for the other role", async () => {
    const { provider, publication } = harness();
    await expect(provider.verifyOwnBundlePublication({
      role: "seller", bundle: BUNDLE, nativeAddress: "stor-native", anchorReceipt: RECEIPT,
    } as never)).resolves.toEqual({
      disposition: "invalid", reason: "vet-terminal-bundle-role-mismatch",
    });
    await expect(provider.submitOwnBundle(
      { role: "seller", logicalAddress: LOGICAL, bundle: BUNDLE } as never,
      undefined as never,
    )).rejects.toThrow("refused: vet-terminal-bundle-role-mismatch");
    expect(publication.verifyBundleAnchorReceipt).not.toHaveBeenCalled();
    expect(publication.submitRoleBundle).not.toHaveBeenCalled();
  });

  test("submits this role's copy inside the conflict fence", async () => {
    const { provider, publication, conflictFenced } = harness();
    await provider.submitOwnBundle(
      { role: "buyer", logicalAddress: LOGICAL, bundle: BUNDLE } as never,
      undefined as never,
    );
    expect(conflictFenced).toHaveBeenCalledOnce();
    expect(publication.submitRoleBundle).toHaveBeenCalledWith("buyer", LOGICAL, BUNDLE);
  });

  const bindingInput = { role: "buyer" as const, logicalAddress: LOGICAL, signer: "did:demos:agent:b" };
  test.each([
    ["present", { disposition: "present", binding: { jobId: "j" } },
      { disposition: "present", value: { jobId: "j" } }],
    ["absent", { disposition: "absent" },
      { disposition: "authoritatively-absent", reason: "vet-terminal-binding-absent" }],
    ["indeterminate", { disposition: "indeterminate", reason: "catalog lag" },
      { disposition: "indeterminate", reason: "catalog lag" }],
  ] as const)("classifies a %s BundleBinding lookup", async (_label, lookup, expected) => {
    const { provider } = harness({ resolveBundleBinding: vi.fn(async () => lookup) });
    await expect(provider.resolveOwnBundleBinding(bindingInput as never)).resolves.toEqual(expected);
  });

  test("rejects a BundleBinding lookup for the other role", async () => {
    const { provider, publication } = harness();
    await expect(provider.resolveOwnBundleBinding({ ...bindingInput, role: "seller" } as never))
      .resolves.toEqual({ disposition: "rejected", reason: "vet-terminal-binding-role-mismatch" });
    expect(publication.resolveBundleBinding).not.toHaveBeenCalled();
  });

  test.each([
    ["valid", { disposition: "valid" }],
    ["invalid", { disposition: "invalid", reason: "vet-terminal-binding-invalid" }],
    ["indeterminate", { disposition: "indeterminate", reason: "vet-terminal-binding-indeterminate" }],
    ["error", { disposition: "indeterminate", reason: "vet-terminal-binding-indeterminate" }],
  ] as const)("classifies a BundleBinding verdict of %s", async (verdict, expected) => {
    const { provider } = harness({ verifyBundleBinding: vi.fn(async () => verdict) });
    await expect(provider.verifyOwnBundleBinding({} as never)).resolves.toEqual(expected);
  });

  test("refuses a BundleBinding publication that was not published", async () => {
    const { provider, conflictFenced } = harness({
      publishRoleBundleBinding: vi.fn(async () => ({
        disposition: "ambiguous", reason: "binding-publication-ambiguous",
      })),
    });
    await expect(provider.publishOwnBundleBinding({} as never, undefined as never))
      .rejects.toThrow("refused: binding-publication-ambiguous");
    expect(conflictFenced).toHaveBeenCalledOnce();
  });
});
