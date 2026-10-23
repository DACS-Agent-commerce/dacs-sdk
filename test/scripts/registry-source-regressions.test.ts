import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
const modulePath = "../../scripts/registry-container-disposition.mjs";
const { registryDependencyViolations } = await import(modulePath);
const registry = "https://example.com/npm/";
const rootLock = () => ({ packages: { "": {} } });
describe("registry dependency source regressions", () => {
  it.each([".", "..", "...", ".hidden", "some tag", "^"])("rejects non-registry spec %s in manifest and lock maps", spec => {
    for (const owner of ["manifest", "lock"]) {
      const manifest = { dependencies: owner === "manifest" ? { x: spec } : {} };
      const lock = { packages: { "": { dependencies: owner === "lock" ? { x: spec } : {} } } };
      expect(registryDependencyViolations({ manifest, lock, registry })).not.toEqual([]);
    }
  });
  it.each(["next!", ">=1.0.0\t<2.0.0", "npm:fixture@next!", "npm:@fixture/package@^1.0.0"])("accepts registry spec %s", spec => {
    expect(registryDependencyViolations({ manifest: { dependencies: { x: spec } }, lock: rootLock(), registry })).toEqual([]);
  });
  it.each([null, undefined, [], "bad"])("rejects a missing or malformed manifest %j", manifest => {
    expect(registryDependencyViolations({ manifest, lock: rootLock(), registry })).not.toEqual([]);
  });
  it.each([{}, { packages: {} }, { packages: { "": null } }, { packages: { "": [] } }])("requires the lock root %j", lock => {
    expect(registryDependencyViolations({ manifest: {}, lock, registry })).not.toEqual([]);
  });
  it.each(["https://example.com/npm", "https://example.com/npm/"])("confines tarballs to registry path %s", configured => {
    for (const [path, allowed] of [["/npm/x.tgz", true], ["/other/x.tgz", false], ["/npm-other/x.tgz", false]] as const) {
      const lock = { packages: { "": {}, "node_modules/x": { version: "1.0.0", resolved: "https://example.com" + path, integrity: "sha512-" + createHash("sha512").update("fixture").digest("base64") } } };
      const violations = registryDependencyViolations({ manifest: {}, lock, registry: configured });
      expect(violations.length === 0, path).toBe(allowed);
    }
  });
});

describe("npm registry grammar and integrity", () => {
  it.each(["^01.2.3", "NPM:is-array@1", " latest ", "npm:@scope/foo.tgz"])("accepts npm registry spec %s", spec => {
    expect(registryDependencyViolations({ manifest: { dependencies: { x: spec } }, lock: rootLock(), registry })).toEqual([]);
  });
  it.each(["npm:node_modules", "npm:favicon.ico"])("rejects an alias without a valid package name: %s", spec => {
    expect(registryDependencyViolations({ manifest: { dependencies: { x: spec } }, lock: rootLock(), registry })).not.toEqual([]);
  });
  const hash = (algorithm: string) => algorithm + "-" + createHash(algorithm).update("fixture").digest("base64");
  it.each([
    ["sha512-A", false], [hash("sha512") + " " + hash("sha256"), true],
    [hash("sha512") + " sha256-A", false], [hash("sha384"), true], [hash("sha1"), true],
  ])("validates each supported SRI digest: %s", (integrity, allowed) => {
    const lock = { packages: { "": {}, "node_modules/x": { version: "1.0.0", resolved: registry + "x.tgz", integrity } } };
    expect(registryDependencyViolations({ manifest: {}, lock, registry }).length === 0).toBe(allowed);
  });
  it.each(["true", 1, {}, null, 0, ""])("rejects malformed link metadata: %j", link => {
    const lock = { packages: { "": {}, "node_modules/x": { resolved: registry + "x.tgz", integrity: hash("sha512"), link } } };
    expect(registryDependencyViolations({ manifest: {}, lock, registry })).toContainEqual(expect.objectContaining({ field: "link" }));
  });
});
