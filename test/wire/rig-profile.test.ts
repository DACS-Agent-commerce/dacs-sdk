import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
let temporary: string, first: string, second: string;
const env = { ...process.env };
delete env.NODE_OPTIONS;
beforeAll(() => {
  mkdirSync(resolve(root, ".fix-tmp"), { recursive: true });
  temporary = mkdtempSync(resolve(root, ".fix-tmp/rig-profile-"));
  first = resolve(temporary, "a/node_modules/@kynesyslabs/dacs");
  second = resolve(temporary, "b/node_modules/@kynesyslabs/dacs");
  mkdirSync(first, { recursive: true });
  const log = resolve(temporary, "build.log"), fd = openSync(log, "w");
  try {
    execFileSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json", "--outDir", resolve(first, "dist")],
      { cwd: root, env, stdio: ["ignore", fd, fd], timeout: 120000 });
  } catch (error) {
    throw new Error(`Rig child build failed: ${readFileSync(log, "utf8").split("\n").filter(line => line.includes("error TS")).slice(0, 15).join("\n")}`, { cause: error });
  } finally { closeSync(fd); }
  writeFileSync(resolve(first, "package.json"), readFileSync(resolve(root, "package.json")));
  cpSync(first, second, { recursive: true });
}, 130000);
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

const cases = [
  ["defaults", "C1: imports, misleading environment and ordinary factories stay closed"],
  ["invalid", "C2: exact owned selection input, no getter/proxy execution, invalid inputs never latch"],
  ["tp1-first", "C3: successful TP-1 binding permanently excludes selection"],
  ["pending", "C3: all pending TP-1 reservations exclude selection; failed reads release only their own reservation"],
  ["pending-success", "C3: selection loses the race to a pending TP-1 bind that succeeds"],
  ["tp1-cross", "C5/C18: TP-1 refuses rig peer and purchase tuples unchanged"],
  ["closed-registry", "C4/C10: duplicate installed copies and lookalike sources fail closed while unselected"],
  ["selected", "C2/C3: selected rig excludes TP-1; immutable selection is single use"],
  ["duplicate", "C4: selecting copy A leaves installed copy B unlatched and rejects A's opaque values"],
  ["identities", "C5: exact rig allowlist refuses testnet, fixtures, refused, synthetic mainnet and 1,000 unequal identities"],
  ["authority", "C6/C10: only registered source, exact connection, participants and fresh observations confer authority"],
  ["deadline", "C6: timed-out and late source replies never produce a binding"],
  ["reset", "C8: run hash is immutable and continuation identity_mismatch prevents signing after reset"],
] as const;
for (const [name, description] of cases) it(`${name} — ${description}`, context => {
  const result = execFileSync(process.execPath, [fileURLToPath(new URL("fixtures/rig-profile-child.mjs", import.meta.url)), name,
    pathToFileURL(resolve(first, "dist/wire/index.js")).href, pathToFileURL(resolve(second, "dist/wire/index.js")).href],
  { cwd: root, env: { ...env, DACS_RIG_PROFILE: "on", KIT_OPERATION_GUARD: "testnet-tp1", PURCHASE_ADMISSION: "testnet-tp1" }, timeout: 25000, encoding: "utf8" });
  const answer = JSON.parse(result);
  if (answer.blocked) context.skip();
  expect(answer).toEqual({ passed: name });
}, 30000);
