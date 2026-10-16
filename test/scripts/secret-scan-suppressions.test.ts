import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const config = await readFile(join(root, ".gitleaks.toml"), "utf8");

// docs/public-repository-cutover.md: keep `.gitleaksignore` entries pinned to exact reviewed
// fingerprints, and never replace them with broad path, rule, regex or commit allowlists.
describe("secret scan suppressions", () => {
  it("pins every .gitleaksignore entry to one commit, file, rule and line", async () => {
    const lines = (await readFile(join(root, ".gitleaksignore"), "utf8")).split("\n");
    expect(lines.filter((line) => line.trim() !== "" && !line.startsWith("#")).length).toBeGreaterThan(0);
    expect(ignoreEntryProblems(lines)).toEqual([]);
  });

  it("rejects ignore entries that are not one exact commit fingerprint", () => {
    const commit = "a".repeat(40);
    const entry = `${commit}:test/a.test.ts:generic-api-key:4`;
    expect(ignoreEntryProblems([entry, "", "# comment"])).toEqual([]);
    const rejected = [
      // Gitleaks matches a three-part entry at that file, rule and line in every commit.
      "test/a.test.ts:generic-api-key:4",
      `${commit.slice(0, 10)}:test/a.test.ts:generic-api-key:4`,
      `${"A".repeat(40)}:test/a.test.ts:generic-api-key:4`,
      `${commit}:test/a:b.test.ts:generic-api-key:4`,
      `${commit}:test/a.test.ts:generic-api-key:`,
      `${commit}:test/a.test.ts:generic-api-key:0`,
      `${commit}:test/a.test.ts:generic-api-key:04`,
    ];
    for (const line of rejected) expect(ignoreEntryProblems([line])).toEqual([line]);
    expect(ignoreEntryProblems([entry, "# comment", entry])).toEqual([`duplicate ${entry}`]);
  });

  it("keeps .gitleaks.toml on the default rules with no allowlists, disabled rules or overrides", () => {
    expect(configProblems(config)).toEqual([]);
  });

  it("rejects every config setting that suppresses more than an exact fingerprint", () => {
    const rule = `[[rules]]\nid = "dacs-extra"\nregex = '''x'''\n`;
    const rejected: [string, string][] = [
      [`${config}\n[allowlist]\npaths = ['''^test/''']\n`, "allowlist"],
      [`${config}\n[[allowlists]]\ntargetRules = ["generic-api-key"]\nregexes = ['''x''']\n`, "allowlist"],
      [`${config}\n[[AllowLists]]\nstopwords = ["x"]\n`, "allowlist"],
      [`${config}\n${rule}[rules.allowlist]\npaths = ['''x''']\n`, "allowlist"],
      [`${config}\n${rule}[[rules.allowlists]]\ncommits = ["x"]\n`, "allowlist"],
      [`${config}\n${rule}allowlists = [{ paths = ['''x'''] }]\n`, "allowlist"],
      [config.replace("useDefault = true", 'useDefault = true\ndisabledRules = ["generic-api-key"]'), "disabledrules"],
      [config.replace("useDefault = true", "useDefault = false"), "extend"],
      [config.replace("useDefault = true", 'path = "other.toml"'), "extend"],
      [config.replace("useDefault = true", 'useDefault = true\nurl = "https://example.invalid/x.toml"'), "extend"],
      [`extend.path = "other.toml"\n${config}`, "extend"],
      // A local rule with a default rule's id replaces that rule's regex, entropy and path.
      [`${config}\n[[rules]]\nid = "generic-api-key"\nentropy = 9.0\n`, 'rule id "generic-api-key"'],
      [`${config}\n[[rules]]\nregex = '''x'''\n`, "rule without id"],
    ];
    for (const [mutant, problem] of rejected) expect(configProblems(mutant)).toContain(problem);
  });
});

// The .gitleaksignore entries that are not `commit:file:rule:line` with a full lowercase commit,
// a file without a colon and a positive line, plus any repeated entry.
function ignoreEntryProblems(lines: string[]) {
  const entries = lines.filter((line) => line.trim() !== "" && !line.startsWith("#"));
  return [
    ...entries.filter((line) => !/^[0-9a-f]{40}:[^:]+:[A-Za-z0-9._-]+:[1-9][0-9]*$/.test(line)),
    ...entries.filter((line, i) => entries.indexOf(line) !== i).map((line) => `duplicate ${line}`),
  ];
}

// The .gitleaks.toml settings that widen what the scan skips. Gitleaks reads keys through viper,
// which ignores case, so `[[AllowLists]]` and `DisabledRules` count too.
function configProblems(text: string) {
  const lower = text.toLowerCase();
  const problems = ["allowlist", "disabledrules"].filter((word) => lower.includes(word));
  const lines = text.split("\n").map((line) => line.trim());
  const start = lines.indexOf("[extend]");
  const end = lines.findIndex((line, i) => i > start && line.startsWith("["));
  const extend = start < 0 ? [] : lines.slice(start + 1, end < 0 ? undefined : end);
  const settings = extend.filter((line) => line !== "" && !line.startsWith("#"));
  // Only the default rules: `path` or `url` would load another config, with its own allowlists.
  if (settings.join("\n") !== "useDefault = true" || lower.split("extend").length !== 2) problems.push("extend");
  const ids = [...text.matchAll(/\bid\s*=\s*("[^"\n]*"|'[^'\n]*')/g)].map((match) => match[1] ?? "");
  problems.push(...ids.filter((id) => !/^"dacs-[a-z0-9-]+"$/.test(id)).map((id) => `rule id ${id}`));
  if (ids.length !== (text.match(/^\s*\[\[\s*rules\s*\]\]/gm)?.length ?? 0)) problems.push("rule without id");
  return problems;
}
