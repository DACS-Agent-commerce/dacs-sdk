import { describe, expect, it } from "vitest";

const checkerPath = "../../scripts/check-registry-dependency-policy.mjs";
const { inspectRegistryDependencyPolicy } = await import(checkerPath);
const registry = "http://127.0.0.1:4873";

function fixture() {
  const dependencies: Record<string, string> = Object.fromEntries([
    "@kynesyslabs/dacs",
    "@kynesyslabs/dacs-node",
    "@kynesyslabs/demosdk",
    "@x402/core",
    "@x402/evm",
    "@x402/fetch",
    "better-sqlite3",
    "viem",
  ].map((name) => [name, "1.0.0"]));
  const manifest = { dependencies };
  const lock: { packages: Record<string, {
    resolved?: string;
    dependencies: Record<string, string>;
    link?: boolean;
  }> } = { packages: {
    "": { dependencies },
    "node_modules/@kynesyslabs/dacs": {
      resolved: `${registry}/@kynesyslabs/dacs/-/dacs-1.0.0.tgz`, dependencies: {},
    },
    "node_modules/@kynesyslabs/dacs-node": {
      resolved: `${registry}/@kynesyslabs/dacs-node/-/dacs-node-1.0.0.tgz`, dependencies: {},
    },
    "node_modules/alias": {
      resolved: `${registry}/bitcoinjs-lib/-/bitcoinjs-lib-5.2.0.tgz`,
      dependencies: { alias: "npm:bitcoinjs-lib@^5.2.0" },
    },
  } };
  return { manifest, lock };
}

describe("isolated-registry dependency policy", () => {
  it("accepts exact local-registry resolutions and registry aliases", () => {
    const { manifest, lock } = fixture();
    expect(inspectRegistryDependencyPolicy(manifest, lock, registry)).toMatchObject({
      passed: true, violations: [],
    });
  });

  it("rejects external direct tarballs, nested specs and GitHub shorthand", () => {
    const { manifest, lock } = fixture();
    manifest.dependencies.viem = "https://example.invalid/viem.tgz";
    lock.packages["node_modules/alias"]!.dependencies.alias =
      "https://example.invalid/alias.tgz";
    lock.packages["node_modules/alias"]!.dependencies.other = "owner/repo#main";
    const report = inspectRegistryDependencyPolicy(manifest, lock, registry);
    expect(report.passed).toBe(false);
    expect(report.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ location: "package.json", field: "dependencies.viem" }),
      expect.objectContaining({ location: "node_modules/alias", field: "dependencies.alias" }),
      expect.objectContaining({ location: "node_modules/alias", field: "dependencies.other" }),
    ]));
  });

  it("rejects package resolutions outside the isolated registry", () => {
    const { manifest, lock } = fixture();
    lock.packages["node_modules/alias"]!.resolved =
      "https://example.invalid/alias.tgz";
    expect(inspectRegistryDependencyPolicy(manifest, lock, registry).violations)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ location: "node_modules/alias", field: "resolved" }),
      ]));
  });

  it("rejects missing required packages and linked entries", () => {
    const { manifest, lock } = fixture();
    delete manifest.dependencies.viem;
    lock.packages["node_modules/alias"]!.link = true;
    const report = inspectRegistryDependencyPolicy(manifest, lock, registry);
    expect(report.passed).toBe(false);
    expect(report.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "dependencies.viem", reason: "missing" }),
      expect.objectContaining({ location: "node_modules/alias", reason: "linked-package" }),
    ]));
  });
});
