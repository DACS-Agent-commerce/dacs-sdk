import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// The kit builds dist before running tests. Use a fresh process so the runner's
// own web globals and Undici imports cannot hide a Node 20 import side effect.
const transportModule = new URL("../../dist/substrate/demosCciTransport.js", import.meta.url).href;
const packageModule = new URL("../../node_modules/undici/index.js", import.meta.url).href;
const child = `
  import assert from "node:assert/strict";
  const slots = ["2", "1"].map(n => Symbol.for("undici.globalDispatcher." + n));
  if (process.argv[1] === "warm") await fetch("data:,warm");
  const before = slots.map(key => globalThis[key]);
  const { defaultCciTransport } = await import(${JSON.stringify(transportModule)});
  const after = slots.map(key => globalThis[key]);
  for (let i = 0; i < slots.length; i++) {
    if (before[i] !== undefined) assert.equal(after[i], before[i]);
  }
  // Loading node:http on newer Node can initialize Node's dispatcher, but
  // importing the SDK must never install the package's dispatcher.
  const response = await defaultCciTransport("http://node.example/rpc")("data:,private");
  assert.equal(await response.text(), "private");
  const { Agent } = await import(${JSON.stringify(packageModule)});
  for (const value of after) assert.equal(value instanceof Agent, false);
  for (const key of slots) assert.equal(globalThis[key] instanceof Agent, false);
  for (let i = 0; i < slots.length; i++) {
    if (before[i] !== undefined) assert.equal(globalThis[slots[i]], before[i]);
  }
  assert.equal(await (await fetch("data:,global")).text(), "global");
  console.log("preserved Node dispatcher; private and global Fetch succeeded");
`;

describe("Demos CCI import preserves Node's global dispatcher", () => {
  it.each(["cold", "warm"])("before and after a private read (%s web globals)", mode => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^((https?|all|no)_proxy|NODE_OPTIONS|NODE_USE_ENV_PROXY)$/i.test(key)) delete env[key];
    }
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", child, mode], {
      env, encoding: "utf8", timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("preserved Node dispatcher; private and global Fetch succeeded");
  });
});
