// Checks what eslint.config.mjs turns on, by asking ESLint for the config of a
// file path. Run it from the repo root after installing tools/lint:
//   node --test tools/lint/eslint-config.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: fileURLToPath(new URL("./eslint.config.mjs", import.meta.url)),
});

test("an unused variable in TypeScript is reported", async () => {
  const [result] = await eslint.lintText("const unusedValue = 1;\nexport {};\n", {
    filePath: "scripts/unused-variable-fixture.ts",
  });
  assert.deepEqual(
    result.messages.map((message) => message.ruleId),
    ["@typescript-eslint/no-unused-vars"],
  );
});

test("an unused function parameter after the last used one is reported in TypeScript", async () => {
  const [result] = await eslint.lintText("export function pick(first: number, second: number): number {\n  return first;\n}\n", {
    filePath: "scripts/unused-parameter-fixture.ts",
  });
  assert.deepEqual(
    result.messages.map((message) => message.ruleId),
    ["@typescript-eslint/no-unused-vars"],
  );
});
