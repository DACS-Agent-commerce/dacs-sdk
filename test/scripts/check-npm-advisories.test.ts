import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

// Keep the production gate executable as plain Node ESM; a computed import lets
// this TypeScript suite exercise it without shipping a second declaration API.
const auditModulePath = "../../scripts/check-npm-advisories.mjs";
const {
  collectAuditVersions,
  decodeAuditResponse,
  requestBulkAdvisories,
  validateAdvisories,
  violationsAtThreshold,
} = await import(auditModulePath);

const lockfile = {
  packages: {
    "": {
      dependencies: { direct: "1.0.0" },
      optionalDependencies: { optional: "2.0.0" },
    },
    "node_modules/direct": { version: "1.0.0" },
    "node_modules/optional": { version: "2.0.0", optional: true },
    "node_modules/transitive": { version: "3.0.0" },
    "node_modules/dev-only": { version: "4.0.0", dev: true },
    "node_modules/shared-optional-dev": { version: "5.0.0", devOptional: true },
    "packages/host": { optionalDependencies: { native: "6.0.0" } },
    "node_modules/native": { version: "6.0.0", optional: true },
  },
};

describe("npm bulk advisory gate", () => {
  it("collects exact repository-wide direct production versions without peers", () => {
    expect(collectAuditVersions(lockfile, { scope: "direct", omit: ["dev"] })).toEqual({
      direct: ["1.0.0"],
      native: ["6.0.0"],
      optional: ["2.0.0"],
    });
  });

  it("honours npm dev and optional omission flags for the installed tree", () => {
    expect(
      collectAuditVersions(lockfile, {
        scope: "all",
        omit: ["dev", "optional"],
      }),
    ).toEqual({ direct: ["1.0.0"], transitive: ["3.0.0"] });
    expect(
      collectAuditVersions(lockfile, { scope: "all", omit: ["dev"] }),
    ).toMatchObject({
      direct: ["1.0.0"],
      native: ["6.0.0"],
      optional: ["2.0.0"],
      "shared-optional-dev": ["5.0.0"],
    });
  });

  it("decodes both ordinary JSON and unlabelled gzip responses", () => {
    const payload = { direct: [] };
    expect(decodeAuditResponse(Buffer.from(JSON.stringify(payload)))).toEqual(payload);
    expect(decodeAuditResponse(gzipSync(JSON.stringify(payload)))).toEqual(payload);
  });

  it("bounds decompressed output as well as response bytes", () => {
    const compressed = gzipSync(JSON.stringify({ direct: ["x".repeat(1_000)] }));
    expect(() => decodeAuditResponse(compressed, 32)).toThrow();
  });

  it("fails closed on malformed or unrequested advisory data", () => {
    expect(() => decodeAuditResponse(Buffer.from("not-json"))).toThrow(/invalid audit JSON/);
    expect(() => validateAdvisories({ surprise: [] }, { direct: ["1.0.0"] })).toThrow(
      /unrequested package/,
    );
    expect(() =>
      validateAdvisories(
        { direct: [{ id: 1, severity: "unknown" }] },
        { direct: ["1.0.0"] },
      ),
    ).toThrow(/invalid severity/);
  });

  it("blocks only advisories at or above the selected threshold", () => {
    const advisories = validateAdvisories(
      {
        direct: [
          { id: 1, severity: "moderate", title: "moderate" },
          { id: 2, severity: "high", title: "high" },
          { id: 3, severity: "critical", title: "critical" },
        ],
      },
      { direct: ["1.0.0"] },
    );
    expect(
      violationsAtThreshold(advisories, "high").map(
        ({ id }: { id: number | string }) => id,
      ),
    ).toEqual([2, 3]);
    expect(violationsAtThreshold(advisories, "none")).toEqual([]);
  });

  it("retries transient failures and accepts a gzip-magic response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(gzipSync(JSON.stringify({ direct: [] })), { status: 200 }),
      );
    await expect(
      requestBulkAdvisories(
        { direct: ["1.0.0"] },
        {
          registry: "http://127.0.0.1:1/",
          attempts: 2,
          timeoutMs: 1_000,
          fetchImpl,
        },
      ),
    ).resolves.toEqual({ direct: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails closed after the bounded retry budget", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("socket closed"));
    await expect(
      requestBulkAdvisories(
        { direct: ["1.0.0"] },
        {
          registry: "http://127.0.0.1:1/",
          attempts: 2,
          timeoutMs: 1_000,
          fetchImpl,
        },
      ),
    ).rejects.toThrow(/failed after 2 attempts/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects an oversized response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ direct: [] }), { status: 200 }),
    );
    await expect(
      requestBulkAdvisories(
        { direct: ["1.0.0"] },
        {
          registry: "http://127.0.0.1:1/",
          attempts: 1,
          timeoutMs: 1_000,
          maximumResponseBytes: 4,
          fetchImpl,
        },
      ),
    ).rejects.toThrow(/exceeded 4 bytes/);
  });
});
