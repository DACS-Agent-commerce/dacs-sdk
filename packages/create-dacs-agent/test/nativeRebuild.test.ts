import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createDacsAgentProject, LIVE_PROFILE } from "../src/index.js";

// The generator resolves `npm` through PATH. These tests put a recording npm
// first on PATH, so the real createDacsAgentProject -> spawn path runs and each
// child process reports its arguments and the npm ignore-scripts settings in its
// environment (npm reads every npm_config_* spelling; the last one wins, and a
// command-line flag beats all of them).

const SHIM_CONFIG = "CREATE_DACS_AGENT_TEST_NPM_SHIM";
const NATIVE_E2E = process.env.CREATE_DACS_AGENT_NATIVE_E2E === "1";
const INHERITED_SPELLINGS = [
  "npm_config_ignore_scripts",
  "NPM_CONFIG_IGNORE_SCRIPTS",
  "npm_config_ignore-scripts",
];

const SHIM = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const config = JSON.parse(readFileSync(process.env.${SHIM_CONFIG}, "utf8"));
const args = process.argv.slice(2);
const ignoreScripts = Object.entries(process.env)
  .filter(([key]) => /^npm_config_/i.test(key) &&
    key.slice(11).replace(/(?!^)_/g, "-").toLowerCase() === "ignore-scripts");
appendFileSync(config.log, JSON.stringify({ args, ignoreScripts }) + "\\n");
if (config.realNpm) {
  const result = spawnSync(config.realNpm, args, {
    cwd: config.fixture, env: process.env, stdio: "inherit",
  });
  process.exit(result.status === null ? 1 : result.status);
}
process.exit(config.exitCodes[args[0] === "run" ? args[1] : args[0]] ?? 0);
`;

interface ShimCall {
  args: string[];
  ignoreScripts: Array<[string, string]>;
}

const temporaryDirectories: string[] = [];
let savedEnvironment: Record<string, string | undefined>;

beforeEach(() => {
  savedEnvironment = Object.fromEntries(
    ["PATH", SHIM_CONFIG, ...INHERITED_SPELLINGS].map((key) => [key, process.env[key]]),
  );
  for (const key of INHERITED_SPELLINGS) delete process.env[key];
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "create-dacs-agent-native-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function installShim(options: {
  exitCodes?: Record<string, number>;
  realNpm?: string;
  fixture?: string;
}): Promise<string> {
  const root = await temporaryDirectory();
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "npm"), SHIM, "utf8");
  await chmod(join(bin, "npm"), 0o755);
  const log = join(root, "calls.jsonl");
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({
    log,
    exitCodes: options.exitCodes ?? {},
    realNpm: options.realNpm,
    fixture: options.fixture,
  }));
  process.env[SHIM_CONFIG] = config;
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  return log;
}

async function calls(log: string): Promise<ShimCall[]> {
  if (!existsSync(log)) return [];
  return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as ShimCall);
}

function liveProject(targetDirectory: string) {
  return createDacsAgentProject({
    targetDirectory,
    mode: "live-demos",
    profile: LIVE_PROFILE,
    role: "buyer",
    install: true,
  });
}

const DISABLED: Array<[string, string]> = [["npm_config_ignore_scripts", "true"]];

describe.skipIf(process.platform === "win32")("live install lifecycle scripts", () => {
  test("only the reviewed better-sqlite3 rebuild turns install scripts back on", async () => {
    const log = await installShim({});
    const project = await liveProject(join(await temporaryDirectory(), "live-agent"));

    expect(project.doctor).toBe("pass");
    expect(await calls(log)).toEqual([
      { args: ["install", "--ignore-scripts", "--omit=optional"], ignoreScripts: DISABLED },
      { args: ["rebuild", "better-sqlite3", "--ignore-scripts=false"], ignoreScripts: DISABLED },
      {
        args: ["run", "dacs:doctor", "--", "--phase", "pre-start", "--for", "start"],
        ignoreScripts: DISABLED,
      },
    ]);
  });

  test("offline installs and runs never turn install scripts back on", async () => {
    const log = await installShim({});
    await createDacsAgentProject({
      targetDirectory: join(await temporaryDirectory(), "offline-agent"),
      install: true,
      run: true,
    });

    expect(await calls(log)).toEqual([
      { args: ["install", "--ignore-scripts", "--omit=optional"], ignoreScripts: DISABLED },
      { args: ["run", "typecheck"], ignoreScripts: DISABLED },
      { args: ["run", "dacs:smoke:offline"], ignoreScripts: DISABLED },
    ]);
  });

  test("a failed rebuild stops generation before the doctor runs", async () => {
    const log = await installShim({ exitCodes: { rebuild: 1 } });

    await expect(liveProject(join(await temporaryDirectory(), "live-agent")))
      .rejects.toThrow(/^npm rebuild better-sqlite3\b.* failed \(exit 1\)$/);
    expect((await calls(log)).map((call) => call.args[0])).toEqual(["install", "rebuild"]);
  });

  // Opt-in (CREATE_DACS_AGENT_NATIVE_E2E=1): needs the npm registry and either
  // the better-sqlite3 prebuilt download or a native toolchain. The generator's
  // real child processes run the real npm in a fixture holding better-sqlite3
  // and decoy packages whose lifecycle scripts leave marker files if they run.
  // Every inherited ignore-scripts spelling and the project's .npmrc ask npm to
  // skip scripts; only the rebuild's command-line flag may override them.
  test.runIf(NATIVE_E2E)("the rebuilt adapter opens a database and no other script runs", async () => {
    const realNpm = execFileSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).trim();
    const fixture = await temporaryDirectory();
    const markers = join(fixture, "markers");
    await mkdir(markers);
    const touch = (name: string) =>
      `node -e "require('fs').writeFileSync('${join(markers, name)}','')"`;
    const hooks = (owner: string, events: string[]) =>
      Object.fromEntries(events.map((event) => [event, touch(`${owner}-${event}`)]));
    const lifecycle = ["preinstall", "install", "postinstall", "prepare"];
    for (const name of ["decoy-child", "decoy"]) {
      const source = join(fixture, "src", name, "package");
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "package.json"), JSON.stringify({
        name,
        version: "1.0.0",
        ...(name === "decoy"
          ? { dependencies: { "decoy-child": `file:${join(fixture, "decoy-child-1.0.0.tgz")}` } }
          : {}),
        scripts: hooks(name, lifecycle),
      }));
      execFileSync("tar", ["-C", join(fixture, "src", name), "-czf",
        join(fixture, `${name}-1.0.0.tgz`), "package"]);
    }
    await writeFile(join(fixture, "probe.cjs"), [
      "const Database = require('better-sqlite3');",
      "const db = new Database(require('path').join(__dirname, 'probe.sqlite'));",
      "db.exec('create table t (v integer)');",
      "db.prepare('insert into t values (?)').run(42);",
      `require('fs').writeFileSync(${JSON.stringify(join(markers, "probe-ok"))},`,
      "  String(db.prepare('select v from t').get().v));",
    ].join("\n"));
    await writeFile(join(fixture, "package.json"), JSON.stringify({
      name: "native-rebuild-fixture",
      version: "1.0.0",
      private: true,
      dependencies: {
        "better-sqlite3": "12.6.2",
        decoy: `file:${join(fixture, "decoy-1.0.0.tgz")}`,
      },
      scripts: {
        ...hooks("root", [...lifecycle, "prerebuild", "rebuild", "postrebuild",
          "predacs:doctor", "postdacs:doctor"]),
        "dacs:doctor": "node probe.cjs",
      },
    }));
    await writeFile(join(fixture, ".npmrc"), "ignore-scripts=true\n");
    for (const key of INHERITED_SPELLINGS) process.env[key] = "true";

    await installShim({ realNpm, fixture });
    const project = await liveProject(join(await temporaryDirectory(), "live-agent"));

    expect(project.doctor).toBe("pass");
    expect(await readdir(markers)).toEqual(["probe-ok"]);
    expect(await readFile(join(markers, "probe-ok"), "utf8")).toBe("42");
  }, 300_000);
});
