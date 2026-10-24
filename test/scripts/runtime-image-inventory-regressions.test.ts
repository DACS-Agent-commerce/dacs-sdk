import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
const inventoryPath = "../../scripts/runtime-image-inventory.mjs";
const policyPath = "../../scripts/registry-container-disposition.mjs";
const { runtimeImageInventory } = await import(inventoryPath);
const { runtimeImageInventoryFindings } = await import(policyPath);
const roots: string[] = [];
const root = () => { const value = mkdtempSync(join(tmpdir(), "dacs-inventory-")); roots.push(value); return value; };
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });
const pkg = (directory: string, name = "a", version = "1.0.0") => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version }));
};
const lock = () => ({ packages: { "": {}, "node_modules/a": { version: "1.0.0", integrity: "sha512-fixture" } } });
describe("runtime inventory boundary regressions", () => {
  it.each([".extra.js", ".hidden"])("records loadable dot entry %s", name => {
    const directory = root(); pkg(join(directory, "node_modules/a"));
    if (name.endsWith(".js")) writeFileSync(join(directory, "node_modules", name), "module.exports = 42;");
    else pkg(join(directory, "node_modules", name), name);
    const inventory = runtimeImageInventory(directory);
    expect(inventory.packages).toContainEqual(expect.objectContaining({ location: "node_modules/" + name }));
    expect(runtimeImageInventoryFindings(inventory, lock()).scanComplete).toBe(false);
  });
  it.each([false, true])("refuses a symlinked root node_modules, dangling=%s", dangling => {
    const directory = root(); const external = join(directory, "external");
    if (!dangling) pkg(join(external, "a"));
    symlinkSync(external, join(directory, "node_modules"), "dir");
    const inventory = runtimeImageInventory(directory);
    expect(inventory.packages).toContainEqual(expect.objectContaining({ location: "node_modules", link: true }));
    expect(runtimeImageInventoryFindings(inventory, lock()).scanComplete).toBe(false);
  });
  it.each([false, true])("refuses a symlinked nested node_modules, dangling=%s", dangling => {
    const directory = root(); pkg(join(directory, "node_modules/a")); const external = join(directory, "external");
    if (!dangling) pkg(join(external, "b"), "b");
    symlinkSync(external, join(directory, "node_modules/a/node_modules"), "dir");
    const inventory = runtimeImageInventory(directory);
    expect(inventory.packages).toContainEqual(expect.objectContaining({ location: "node_modules/a/node_modules", link: true }));
    expect(runtimeImageInventoryFindings(inventory, lock()).scanComplete).toBe(false);
  });
  it.each([{}, { packages: {} }, { packages: { "": null } }, { packages: { "": [] } }])("rejects a missing lock root %j", input => {
    expect(runtimeImageInventoryFindings({ schema: "dacs-runtime-image-inventory/v1", packages: [] }, input).scanComplete).toBe(false);
  });
  it.each([
    ["extra", "node_modules/extra", "extra", "1.0.0", false],
    ["dev-only", "node_modules/a", "a", "1.0.0", true],
    ["wrong version", "node_modules/a", "a", "2.0.0", false],
    ["wrong name", "node_modules/a", "other", "1.0.0", false],
  ] as const)("reports %s with its exact identity", (_label, location, name, version, dev) => {
    const input = { packages: { "": {}, "node_modules/a": { version: "1.0.0", integrity: "sha512-fixture", dev } } };
    expect(runtimeImageInventoryFindings({ schema: "dacs-runtime-image-inventory/v1", packages: [{ location, name, version }] }, input))
      .toMatchObject({ scanComplete: true, unexpected: [{ location, name, version, integrity: location === "node_modules/a" ? "sha512-fixture" : null }] });
  });
});

describe("inventory metadata and lock entry validation", () => {
  it.each([".bin file", ".bin link", ".package-lock.json link", ".package-lock.json directory"])(
    "records an unexpected metadata entry type: %s", kind => {
      const directory = root(); pkg(join(directory, "node_modules/a"));
      const name = kind.slice(0, kind.indexOf(" "));
      const path = join(directory, "node_modules", name);
      if (kind.endsWith("link")) symlinkSync(join(directory, "node_modules/a"), path);
      else if (kind.endsWith("directory")) pkg(path, name);
      else writeFileSync(path, "module.exports = 42;");
      const inventory = runtimeImageInventory(directory);
      expect(inventory.packages).toContainEqual(expect.objectContaining({ location: "node_modules/" + name }));
      expect(runtimeImageInventoryFindings(inventory, lock()).scanComplete).toBe(false);
    });
  it.each(["@node_modules/a", "@some_node_modules/a"])("derives the scoped identity %s at path boundaries", name => {
    for (const location of [`node_modules/${name}`, `node_modules/parent/node_modules/${name}`]) {
      expect(runtimeImageInventoryFindings({ schema: "dacs-runtime-image-inventory/v1", packages: [
        { location, name, version: "1.0.0" },
      ] }, { packages: { "": {}, [location]: { version: "1.0.0" } } }))
        .toEqual({ scanComplete: true, errors: [], unexpected: [], missing: [] });
    }
  });
  it.each([null, [], "invalid", 1])("reports malformed lock entries without throwing: %j", entry => {
    const directory = root(); pkg(join(directory, "node_modules/a"));
    expect(runtimeImageInventoryFindings(runtimeImageInventory(directory), { packages: { "": {}, "node_modules/a": entry } }))
      .toMatchObject({ scanComplete: false, errors: [expect.stringMatching(/malformed.*lock/)] });
  });
});

describe("inventory fail-closed metadata and diagnostics", () => {
  it.each([
    { optional: true }, { dev: true }, { version: "" }, { version: "  " },
  ])("rejects a non-link lock record without a nonblank version before filtering: %j", entry => {
    expect(runtimeImageInventoryFindings({ schema: "dacs-runtime-image-inventory/v1", packages: [] },
      { packages: { "": {}, "node_modules/a": entry } }))
      .toMatchObject({ scanComplete: false, errors: [expect.stringContaining("node_modules/a")] });
  });
  it.each([{ name: "", version: "1.0.0" }, { name: "a", version: "" }, { name: "  ", version: "1.0.0" }])(
    "rejects a blank inventory identity %j", identity => {
      expect(runtimeImageInventoryFindings({ schema: "dacs-runtime-image-inventory/v1", packages: [
        { location: "node_modules/a", ...identity },
      ] }, lock())).toMatchObject({ scanComplete: false });
    });
  it.each([false, true])("preserves manifest failure cause, invalid JSON=%s", invalid => {
    const directory = root();
    mkdirSync(join(directory, "node_modules/a"), { recursive: true });
    if (invalid) writeFileSync(join(directory, "node_modules/a/package.json"), "{invalid");
    const inventory = runtimeImageInventory(directory);
    const findings = runtimeImageInventoryFindings(inventory, lock());
    expect(findings.scanComplete).toBe(false);
    expect(inventory.packages[0].error).toMatch(invalid ? /SyntaxError/ : /ENOENT/);
    expect(findings.errors[0]).toContain(inventory.packages[0].error);
  });
});

describe("inventory executable entries", () => {
  it.each(["file", "unlisted link", "wrong target", "dangling link"])("rejects an unjustified .bin entry: %s", kind => {
    const directory = root(); pkg(join(directory, "node_modules/a"));
    mkdirSync(join(directory, "node_modules/.bin"));
    writeFileSync(join(directory, "node_modules/a/cli.js"), "module.exports = 42;");
    const command = join(directory, "node_modules/.bin/evil.js");
    if (kind === "file") writeFileSync(command, "module.exports = 42;");
    else symlinkSync(kind === "dangling link" ? "../a/missing.js" : "../a/cli.js", command);
    const input = lock();
    const locked = kind === "wrong target" ? { ...input, packages: { ...input.packages,
      "node_modules/a": { ...input.packages["node_modules/a"], bin: { "evil.js": "other.js" } } } } : input;
    expect(runtimeImageInventoryFindings(runtimeImageInventory(directory), locked))
      .toMatchObject({ scanComplete: false, errors: [expect.stringContaining(".bin/evil.js")] });
  });
  it.each(["node_modules/a", "node_modules/@s/a", "node_modules/parent/node_modules/a"])(
    "accepts a bin link justified by the locked declaration at %s", location => {
      const directory = root(); pkg(join(directory, location), location.includes("@s/") ? "@s/a" : "a");
      const modules = location.replace(/(?:@[^/]+\/)?[^/]+$/, "");
      mkdirSync(join(directory, modules, ".bin"), { recursive: true });
      writeFileSync(join(directory, location, "cli.js"), "module.exports = 42;");
      symlinkSync(join(directory, location, "cli.js"), join(directory, modules, ".bin/a"));
      if (location.includes("parent")) pkg(join(directory, "node_modules/parent"), "parent");
      const input = { packages: { "": {}, [location]: { version: "1.0.0", bin: { a: "cli.js" } },
        ...(location.includes("parent") ? { "node_modules/parent": { version: "1.0.0" } } : {}) } };
      expect(runtimeImageInventoryFindings(runtimeImageInventory(directory), input))
        .toEqual({ scanComplete: true, errors: [], unexpected: [], missing: [] });
    });
});
