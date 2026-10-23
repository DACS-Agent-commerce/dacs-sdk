// All processes and Docker state are local doubles.
// The stop double implements Compose v2.10.2/v2.40.3 oneOffExclude semantics.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import ts from "typescript";
import { projectTemplates } from "../src/index.js";

test.each(["buyer", "seller"])("maintenance refuses when compose stop leaves a one-off %s writer running", async (role) => {
  const root = await mkdtemp(join(tmpdir(), "dacs-oneoff-maintenance-"));
  try {
    const target = join(root, "agent");
    const bin = join(root, "bin");
    await mkdir(join(target, "scripts"), { recursive: true });
    await mkdir(join(target, ".dacs-runtime"), { mode: 0o700 });
    await mkdir(bin);
    const identity = "a".repeat(32);
    const project = "agent-" + createHash("sha256").update(identity + target).digest("hex").slice(0, 12);
    const files = projectTemplates({ packageName: "agent", mode: "live-demos", deployment: "docker",
      role: "buyer", rails: "pay-dem", projectIdentity: identity });
    const source = files["scripts/docker-runtime-smoke.mjs"]!;
    await writeFile(join(target, "scripts/docker-runtime-smoke.mjs"), source);
    await writeFile(join(target, ".env"), "");
    const observed = await stat(target, { bigint: true });
    await writeFile(join(target, ".dacs-runtime/compose-project.json"), JSON.stringify({
      recordVersion: 1, project, directory: target, device: String(observed.dev), inode: String(observed.ino),
    }));
    const containers = [false, true].map((oneoff, i) => ({
      Id: "container" + i,
      Config: { Labels: { "com.docker.compose.project": project, "com.docker.compose.service": role,
        "com.docker.compose.project.working_dir": target, "com.docker.compose.oneoff": oneoff ? "True" : "False" } },
      State: { Running: true },
    }));
    const statePath = join(root, "containers.json");
    await writeFile(statePath, JSON.stringify(containers));
    const fake = join(bin, "docker");
    await writeFile(fake, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const path = process.env.DACS_TEST_DOCKER_STATE;
const state = JSON.parse(fs.readFileSync(path, "utf8"));
if (args[0] === "compose" && args[1] === "version") console.log("2.40.3");
else if (args[0] === "ps") console.log(state.map(c => c.Id).join("\\n"));
else if (args[0] === "container" && args[1] === "inspect") console.log(JSON.stringify(state));
else if (args[0] === "compose" && args.includes("stop")) {
  for (const c of state) if (c.Config.Labels["com.docker.compose.oneoff"] !== "True") c.State.Running = false;
  fs.writeFileSync(path, JSON.stringify(state));
} else { console.error("Unexpected read-only fake command", args); process.exit(99); }
`);
    await chmod(fake, 0o755);
    const result = spawnSync(process.execPath, [join(target, "scripts/docker-runtime-smoke.mjs"), "--stop"], {
      cwd: target, encoding: "utf8", env: { PATH: bin, DACS_TEST_DOCKER_STATE: statePath }, timeout: 10_000,
    });
    const after = JSON.parse(await readFile(statePath, "utf8"));
    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain("maintenance refused");
    expect(after.find((c: any) => c.Config.Labels["com.docker.compose.oneoff"] === "False").State.Running).toBe(false);
    expect(after.find((c: any) => c.Config.Labels["com.docker.compose.oneoff"] === "True").State.Running).toBe(true);
    expect(result.status, "a running one-off writer must block backup/restore instead of returning success").not.toBe(0);
    // Exercise the generated maintenance CLI too: a surviving writer must
    // prevent both safety backup and directory replacement after confirmation.
    const js = ts.transpileModule(files["src/cli.ts"]!, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const parsed = ts.createSourceFile("cli.mjs", js, ts.ScriptTarget.ES2022, true);
    const names = new Set<string>();
    for (const statement of parsed.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
          statement.moduleSpecifier.text.startsWith("node:")) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) throw new Error("unexpected CLI import");
      for (const element of bindings.elements) names.add((element.propertyName ?? element.name).text);
    }
    const marker = join(target, "maintenance-wrote-data");
    const implementations: Record<string, string> = {
      VERSION: '"fixture"', FIXED_PRICE_X402_STANDARD_REVISION: '"fixture"',
      DACS_NODE_LIVE_PROFILE: '"fixture"',
      inspectGeneratedBackupV1: '() => ({ backupId: "fixture" })',
      assertGeneratedBackupRestorableV1: '() => {}',
      createGeneratedBackupV1: '() => { writeFileSync(marker, "backup"); return { backupId: "fixture" }; }',
      restoreGeneratedBackupV1: '() => { writeFileSync(marker, "restore"); return {}; }',
    };
    await writeFile(join(target, "stubs.mjs"),
      'import { writeFileSync } from "node:fs";\nconst marker = ' + JSON.stringify(marker) + ';\n' +
      [...names].map((name) => `export const ${name} = ${implementations[name] ??
        '() => { throw new Error("unexpected dependency call"); }'};`).join("\n"));
    await writeFile(join(target, "cli.mjs"), js.replace(/from "([^"\n]+)"/g,
      (full, specifier: string) => specifier.startsWith("node:") ? full : 'from "./stubs.mjs"'));
    const actorFile = join(target, "actor-data");
    await writeFile(actorFile, "original data");
    for (const args of [
      ["restore", "--from", "fixture", "--backup-id", "fixture", "--safety-backup", "safety", "--non-interactive"],
      ["backup", "--output", "fixture"],
      ["uninstall", "--backup", "fixture", "--non-interactive"],
    ]) {
      const maintenance = spawnSync(process.execPath, [join(target, "cli.mjs"), ...args], {
        cwd: target, encoding: "utf8", timeout: 10_000,
        env: { PATH: bin, DACS_TEST_DOCKER_STATE: statePath, DACS_DEPLOYMENT: "docker",
          DACS_RESTORE_CONFIRM: "1", DACS_UNINSTALL_CONFIRM: "1" },
      });
      expect(maintenance.error).toBeUndefined();
      expect(maintenance.status, maintenance.stderr).toBe(5);
      expect(maintenance.stderr).toContain("maintenance refused");
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(actorFile, "utf8")).toBe("original data");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
