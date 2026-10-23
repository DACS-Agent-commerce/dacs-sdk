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
