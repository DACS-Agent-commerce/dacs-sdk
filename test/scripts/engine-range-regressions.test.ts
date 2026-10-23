import { describe, expect, it } from "vitest";
const modulePath = "../../scripts/registry-container-disposition.mjs";
const { scanLockEngines, satisfiesEngineRange } = await import(modulePath);
const versions = { node: "20.19.1", npm: "11.19.0" };
const scan = (range: string) => scanLockEngines({ packages: { "": { name: "fixture", version: "1.0.0", engines: { node: range } } } }, versions);
describe("npm engine range boundary regressions", () => {
  it.each([">=", "^", "<"])("rejects an overlong concrete prerelease in %s", operator => {
    const result = scan(operator + "20.0.0-" + "a".repeat(250));
    expect(result.scanComplete === false || result.violations.length > 0).toBe(true);
  });
  it.each(["20.0.0-" + "a".repeat(250) + " - 30.0.0", "1.0.0 - 30.0.0-" + "a".repeat(250)])("rejects an overlong hyphen bound %s", range => {
    expect(scan(range).scanComplete).toBe(false);
  });
  it.each(["1000000000000000", "9007199254740991"])("accepts a safe 16-digit component %s", bound => {
    expect(satisfiesEngineRange("20.19.1", "<" + bound)).toBe(true);
    expect(scan("<" + bound)).toMatchObject({ scanComplete: true, violations: [] });
  });
  it.each(["9007199254740992", "9999999999999999"])("rejects an unsafe component %s", bound => {
    expect(scan("<" + bound).scanComplete).toBe(false);
  });
  it.each([{}, { packages: {} }, { packages: { "": null } }, { packages: { "": [] } }])("requires the lock root %j", lock => {
    expect(scanLockEngines(lock, versions).scanComplete).toBe(false);
  });
});
