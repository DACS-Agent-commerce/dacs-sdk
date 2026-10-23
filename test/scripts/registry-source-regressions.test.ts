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
      const lock = { packages: { "": {}, "node_modules/x": { version: "1.0.0", resolved: "https://example.com" + path, integrity: "sha512-Zml4dHVyZQ==" } } };
      const violations = registryDependencyViolations({ manifest: {}, lock, registry: configured });
      expect(violations.length === 0, path).toBe(allowed);
    }
  });
});
