import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const modulePath = "../../scripts/registry-container-disposition.mjs";
const policy = await import(modulePath);
const baseline = JSON.parse(readFileSync(new URL("../../scripts/registry-container-audit-baseline.json", import.meta.url), "utf8"));
const listed = "GHSA-23hp-3jrh-7fpw";
const assessed = "GHSA-2222-2222-2222";
const unlisted = "GHSA-3333-3333-3333";
describe("curated advisory validation regressions", () => {
  it("preserves every curated advisory ID", () => {
    expect(baseline.advisoryIds).toHaveLength(94);
    expect(createHash("sha256").update([...baseline.advisoryIds].sort().join("\n")).digest("hex"))
      .toBe("4b074bb8a027bda7adf6542f2530747390a7ce06bcf516bf74f93685ff8f75fe");
  });
  it("classifies listed, assessed, unlisted and direct observations without mutation", () => {
    const configured = { ...baseline, assessedAdvisories: [{ id: assessed, assessment: "SECURITY.md fixture assessment" }] };
    const observed = [unlisted, listed, assessed];
    const before = JSON.stringify([observed, configured]);
    expect(policy.classifyRegistryAudit(observed, configured, [unlisted, listed])).toEqual({
      observedAdvisories: [assessed, listed, unlisted], assessedAdvisories: [assessed],
      unlistedAdvisories: [unlisted], directAdvisories: [listed, unlisted],
    });
    expect(JSON.stringify([observed, configured])).toBe(before);
  });
  it.each([null, undefined, {}, "bad"])("rejects invalid or absent assessment arrays: %s", assessedAdvisories => {
    expect(() => policy.classifyRegistryAudit([], { ...baseline, assessedAdvisories })).toThrow(/malformed/);
  });
  it("requires a nonblank source job", () => {
    expect(() => policy.classifyRegistryAudit([], { ...baseline, source: { ...baseline.source, job: "  " } })).toThrow(/malformed/);
  });
  it.each([
    { advisoryIds: [listed, listed] },
    { advisoryIds: ["invalid"] },
    { schema: "unknown" },
    { source: { ...baseline.source, commit: "bad" } },
    { assessedAdvisories: [{ id: listed, assessment: "overlap" }] },
    { assessedAdvisories: [{ id: assessed, assessment: " " }] },
    { assessedAdvisories: [{ id: assessed, assessment: "ok" }, { id: assessed, assessment: "duplicate" }] },
  ])("rejects malformed baseline %j", change => {
    expect(() => policy.classifyRegistryAudit([], { ...baseline, ...change })).toThrow(/malformed/);
  });
  it.each([[listed, listed], ["invalid"], null])("rejects invalid observed IDs %j", observed => {
    expect(() => policy.classifyRegistryAudit(observed, baseline)).toThrow(/malformed/);
  });
  it("rejects unobserved direct IDs", () => {
    expect(() => policy.classifyRegistryAudit([], baseline, [listed])).toThrow(/malformed/);
  });
  it("imports only implemented policy exports in the primary suite", () => {
    const suite = readFileSync(resolve(import.meta.dirname, "registry-container-disposition.test.ts"), "utf8");
    const names = /const \{([^}]+)\} =\s*await import/.exec(suite)?.[1]?.split(",").map(name => name.trim()) ?? [];
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(policy[name], name).toBeDefined();
  });
});

describe("baseline input completeness", () => {
  it.each(["observed", "baseline", "assessments", "direct"])("rejects sparse %s arrays", input => {
    const sparse = Array(1);
    const configured = { ...baseline,
      ...(input === "baseline" ? { advisoryIds: sparse } : {}),
      ...(input === "assessments" ? { assessedAdvisories: sparse } : {}),
    };
    expect(() => policy.classifyRegistryAudit(input === "observed" ? sparse : [listed], configured,
      input === "direct" ? sparse : [])).toThrow(/malformed/);
  });
  it.each([
    { url: undefined }, { evidence: undefined }, { url: " " }, { evidence: " " },
    { url: "https://github.com/DACS-Agent-commerce/dacs-sdk/runs/123" },
    { url: "https://example.invalid/runs/114652354976" },
  ])("requires source evidence and a URL identifying the declared job: %j", change => {
    expect(() => policy.classifyRegistryAudit([], { ...baseline, source: { ...baseline.source, ...change } }))
      .toThrow(/malformed/);
  });
});


describe("baseline evidence preservation", () => {
  it.each(["not-a-job", "0", "-1", "1.5", " 123", "123 "])("rejects malformed matching source job and URL: %s", job => {
    expect(() => policy.classifyRegistryAudit([], { ...baseline, source: { ...baseline.source, job,
      url: `https://github.com/DACS-Agent-commerce/dacs-sdk/runs/${job}` } })).toThrow(/malformed/);
  });
  it("preserves the recorded policy finding groups and every entry", () => {
    expect(Object.keys(baseline.policyFindings)).toEqual([
      "source", "gitDependencies", "engineViolations", "lockSbomProblems", "physicalSbomProblems",
      "productionImageDependencies", "additionalSources",
    ]);
    for (const group of ["gitDependencies", "engineViolations", "lockSbomProblems", "physicalSbomProblems",
      "productionImageDependencies", "additionalSources"]) {
      expect(Array.isArray(baseline.policyFindings[group]), group).toBe(true);
      expect(baseline.policyFindings[group].length, group).toBeGreaterThan(0);
    }
    expect(createHash("sha256").update(JSON.stringify(baseline.policyFindings)).digest("hex"))
      .toBe("3aa20108c9fcbb5d7ee68c94ce799564fabcfdde57dba85089d011eb1a216b9e");
  });
});
