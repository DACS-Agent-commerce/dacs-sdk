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

describe("expanded semver numeric limits", () => {
  it.each([
    "<=9007199254740991", "^9007199254740991", ">9007199254740991",
    "<=20.9007199254740991", "~20.9007199254740991", "^0.9007199254740991.0",
    "^0.0.9007199254740991", "0.0.0 - 20.19.9007199254740991",
    "0 - 9007199254740991", ">=20 || <=9007199254740991",
  ])("rejects an overflowing expanded comparator in %s", range => {
    expect(scan(range)).toMatchObject({ scanComplete: false, errors: [expect.stringMatching(/range|bound/)] });
  });
});

describe("pinned npm semver compatibility", () => {
  it.each([">=v20.0.0-", "v20.0.0-"])("counts a retained v in the concrete lower bound %s", prefix => {
    const suffix = prefix.startsWith(">=") ? "" : " - 30.0.0";
    // semver 7.8.5 retains v in concrete comparators, including a hyphen's lower bound.
    expect(scan(prefix + "a".repeat(248) + suffix)).toMatchObject({ scanComplete: true, violations: [] });
    const result = scan(prefix + "a".repeat(249) + suffix);
    expect(result.scanComplete === false || result.violations.length > 0).toBe(true);
  });
  it.each(["^1.2+build", "~20+build", ">=20.1+build", "20+build - 21+build"])(
    "accepts partial build metadata in %s", range => {
      const expected = range !== "^1.2+build";
      expect(satisfiesEngineRange(versions.node, range)).toBe(expected);
      const result = scan(range);
      expect(result.scanComplete).toBe(true);
      expect(result.violations).toHaveLength(expected ? 0 : 1);
    });
  it.each(["@node_modules/a", "@some_node_modules/a"])("preserves the complete scoped engine finding identity %s", name => {
    for (const location of [`node_modules/${name}`, `node_modules/parent/node_modules/${name}`]) {
      expect(scanLockEngines({ packages: { "": {}, [location]: { version: "1.0.0", engines: { node: ">=26" } } } }, versions))
        .toMatchObject({ scanComplete: true, violations: [{ package: `${name}@1.0.0`, location }] });
    }
  });
});

describe("stripped concrete build metadata", () => {
  it.each(["20.0.0+", "v20.0.0+"])("strips build metadata before checking a plain comparator: %s", version => {
    const bound = version + "a".repeat(256 - version.length);
    expect(scan(">=" + bound)).toMatchObject({ scanComplete: true, violations: [] });
    expect(scan(">=" + bound + "a")).toMatchObject({ scanComplete: true, violations: [] });
    // Caret expansion discards build metadata before constructing comparators.
    expect(scan("^" + bound + "a")).toMatchObject({ scanComplete: true, violations: [] });
  });
  it("strips build metadata before expanding a concrete hyphen lower bound", () => {
    const bound = "v20.0.0+" + "a".repeat(247);
    expect(scan(bound + " - 30.0.0")).toMatchObject({ scanComplete: true, violations: [] });
  });
});
