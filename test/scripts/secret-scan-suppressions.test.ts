import { readdir, readFile } from "node:fs/promises";
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

  it.each([
    ["an absent keyword", 'keywords = ["never-a-source-token"]', "keywords"],
    ["a different regex", "regex = '''NEVER_MATCH_THIS_MARKER'''", "regex"],
    ["a different capture group", "secretGroup = 0", "secretGroup"],
    ["missing keywords", "", "keywords"],
    ["a missing regex", "", "regex"],
    ["a missing capture group", "", "secretGroup"],
  ])("rejects the mnemonic rule with %s", (_description, replacement, key) => {
    const changed = config.replace(new RegExp(`^${key} = .*\\n?`, "m"), `${replacement}\n`);
    expect(configProblems(changed)).toContain(`mnemonic rule ${key}`);
  });

  it("requires the reviewed mnemonic rule even if it is removed or renamed", () => {
    const withoutRule = config.replace(/\[\[rules\]\][\s\S]*/, "");
    const renamedRule = config.replace('id = "dacs-mnemonic-assignment"', 'id = "dacs-other"');
    for (const changed of [withoutRule, renamedRule]) {
      expect(configProblems(changed)).toContain("expected one reviewed mnemonic rule");
    }
  });

  it.each(["regex", "secretGroup", "keywords"])("rejects a repeated mnemonic %s setting", (key) => {
    const setting = config.split("\n").find((line) => line.startsWith(`${key} = `))!;
    expect(configProblems(`${config}\n${setting}\n`)).toContain(`mnemonic rule ${key}`);
  });

  it("rejects every config setting that suppresses more than an exact fingerprint", () => {
    const rule = `[[rules]]\nid = "dacs-extra"\nregex = '''x'''\n`;
    expect(configProblems(`${config}\n${rule}keywords = ["x"]\n`)).toEqual([]);
    const rejected: [string, string][] = [
      [`${config}\n[allowlist]\npaths = ['''^test/''']\n`, "table [allowlist]"],
      [`${config}\n[[allowlists]]\ntargetRules = ["generic-api-key"]\nregexes = ['''x''']\n`, "table [[allowlists]]"],
      [`${config}\n[[AllowLists]]\nstopwords = ["x"]\n`, "table [[AllowLists]]"],
      [`${config}\n${rule}[rules.allowlist]\npaths = ['''x''']\n`, "table [rules.allowlist]"],
      [`${config}\n${rule}[[rules.allowlists]]\ncommits = ["x"]\n`, "table [[rules.allowlists]]"],
      [`${config}\n${rule}allowlists = [{ paths = ['''x'''] }]\n`, "setting allowlists = [{ paths = ['''x'''] }]"],
      [config.replace("useDefault = true", 'useDefault = true\ndisabledRules = ["generic-api-key"]'), 'setting disabledRules = ["generic-api-key"]'],
      [config.replace("useDefault = true", "useDefault = false"), "extend"],
      [config.replace("[extend]\nuseDefault = true", ""), "extend"],
      [config.replace("useDefault = true", 'path = "other.toml"'), 'setting path = "other.toml"'],
      [config.replace("useDefault = true", 'useDefault = true\nurl = "https://example.invalid/x.toml"'), 'setting url = "https://example.invalid/x.toml"'],
      [`extend.path = "other.toml"\n${config}`, 'setting extend.path = "other.toml"'],
      [config.replace("[extend]", "[Extend]"), "table [Extend]"],
      // A rule with a default rule's id, or another local rule's, replaces that rule.
      [`${config}\n[[rules]]\nid = "generic-api-key"\nentropy = 9.0\n`, 'rule id "generic-api-key"'],
      [`${config}\n[[rules]]\nid = "dacs-mnemonic-assignment"\nregex = '''x'''\n`, 'duplicate rule id "dacs-mnemonic-assignment"'],
      [`${config}\n[[rules]]\nregex = '''x'''\n`, "rule without id"],
      // Viper ignores case, so this is the rule's id; the commented line above it is not.
      [`${config}\n[[rules]]\n# id = "dacs-decoy"\nID = "generic-api-key"\nregex = '''x'''\n`, 'setting ID = "generic-api-key"'],
      [`${config}\n[[rules]]\n# id = "dacs-decoy"\nID = "generic-api-key"\nregex = '''x'''\n`, "rule without id"],
      // The rule still matches, but gitleaks reports none of its findings.
      [config.replace("secretGroup = 1", "secretGroup = 1\nskipReport = true"), "setting skipReport = true"],
      [config.replace("secretGroup = 1", "secretGroup = 1\nSkipReport = true"), "setting SkipReport = true"],
      [`${config}\n${rule}[[rules.required]]\nid = "dacs-mnemonic-assignment"\n`, "table [[rules.required]]"],
      // A value that runs onto the next lines could hide a table or setting in them.
      [`${config}\n${rule}description = '''\n[[allowlists]]\n'''\n`, "setting description = '''"],
    ];
    for (const [mutant, problem] of rejected) expect(configProblems(mutant)).toContain(problem);
  });

  // Gitleaks finds its config through viper, which tries `.gitleaks.json` before `.gitleaks.toml`
  // and reads either as TOML, so another root config would replace the one checked above.
  it("has no root gitleaks config other than .gitleaks.toml", async () => {
    const configs = (await readdir(root)).filter((name) => /^\.gitleaks(?!ignore$)/i.test(name));
    expect(configs).toEqual([".gitleaks.toml"]);
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

// The only tables and keys .gitleaks.toml may use, spelled exactly as here. Gitleaks reads keys
// through viper, which ignores case, so `ID` or `SkipReport` would still be read: any other
// table, key or spelling is a problem. Left out because each makes gitleaks report less than the
// rules find: allowlists, `disabledRules`, extend `path` (another config, with its own
// allowlists), and a rule's `skipReport`, `required`, `entropy` and `path`.
const configKeys = new Map([
  ["", ["title", "minVersion"]],
  ["[extend]", ["useDefault"]],
  ["[[rules]]", ["id", "description", "regex", "secretGroup", "keywords"]],
]);
// A TOML string, boolean, number or array of strings that ends on the line it starts on, so no
// table or setting can hide in a value that runs onto the next lines.
const tomlString = String.raw`"(?:[^"\\\n]|\\.)*"|'''(?:(?!''')[^\n])*'''|'[^'\n]*'`;
const tomlValue = new RegExp(
  String.raw`^(?:${tomlString}|true|false|-?\d+(?:\.\d+)?|\[\s*(?:(?:${tomlString})\s*,\s*)*(?:(?:${tomlString})\s*)?\])$`,
);
// Allowed keys alone cannot keep a rule active: changing its keyword prefilter or regex can
// silently stop detection. Keep the reviewed mnemonic rule's detection settings exact, too.
const mnemonicSettings = new Map([
  ["regex", String.raw`'''(?i)(?:mnemonic|seed[_ -]?phrase)\s*(?:=|:)\s*["'\x60]([a-z]+(?:\s+[a-z]+){11,23})["'\x60]'''`],
  ["secretGroup", "1"],
  ["keywords", '["mnemonic", "seed_phrase", "seed phrase"]'],
]);

// The .gitleaks.toml lines that widen what the scan skips, read table by table the way TOML does.
function configProblems(text: string) {
  const problems: string[] = [];
  const tables: { header: string; settings: [string, string][] }[] = [{ header: "", settings: [] }];
  for (const line of text.split("\n").map((line) => line.trim())) {
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      if (!configKeys.has(line)) problems.push(`table ${line}`);
      tables.push({ header: line, settings: [] });
      continue;
    }
    const table = tables[tables.length - 1]!;
    const [, key = "", value = ""] = /^([A-Za-z]+)\s*=\s*(.*)$/.exec(line) ?? [];
    if (configKeys.get(table.header)?.includes(key) && tomlValue.test(value)) table.settings.push([key, value]);
    else problems.push(`setting ${line}`);
  }
  const settings = (header: string) => tables.filter((table) => table.header === header).map((table) => table.settings);
  // Only the default rules: without `useDefault = true`, gitleaks runs this file's rules alone.
  if (JSON.stringify(settings("[extend]")) !== JSON.stringify([[["useDefault", "true"]]])) problems.push("extend");
  // A rule with a default rule's id, or another local rule's, replaces that rule.
  const rules = settings("[[rules]]");
  const ids = rules.map((rule) => rule.filter(([key]) => key === "id").map(([, value]) => value));
  problems.push(...ids.flat().filter((id) => !/^"dacs-[a-z0-9-]+"$/.test(id)).map((id) => `rule id ${id}`));
  problems.push(...ids.flat().filter((id, i, all) => all.indexOf(id) !== i).map((id) => `duplicate rule id ${id}`));
  if (ids.some((rule) => rule.length === 0)) problems.push("rule without id");
  const mnemonic = rules.filter((rule) => rule.some(([key, value]) => key === "id" && value === '"dacs-mnemonic-assignment"'));
  if (mnemonic.length !== 1) problems.push("expected one reviewed mnemonic rule");
  else {
    for (const [key, expected] of mnemonicSettings) {
      const values = mnemonic[0]!.filter(([name]) => name === key).map(([, value]) => value);
      if (values.length !== 1 || values[0] !== expected) problems.push(`mnemonic rule ${key}`);
    }
  }
  return problems;
}
