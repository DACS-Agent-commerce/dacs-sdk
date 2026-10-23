import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test, vi, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
// The probe exercises the built package, as the scheduled job does.
import { nodeRecord } from "../fixtures/demosNodeScript.js";

const expected = { hash: "12".repeat(32), payer: "ab".repeat(32), payee: "cd".repeat(32),
  amountOs: "1000000000", nonce: 9, blockNumber: 42, denomination: "os", state: "executed" };
const approvedCommit = "52e2e5698bd9785ddd709de33e4709d5dd7bc308";
const version = { commit: `<stabilisation>${approvedCommit}` };
const info = { forks: { osDenomination: { activated: true } }, nodeVersion: { commit: approvedCommit, dirty: false } };
test.skipIf(!existsSync(new URL("../../dist/rails/payDem.js", import.meta.url)))(
"deployment probe accepts a bound record and rejects changed status and amount", async () => {
  // @ts-expect-error the operational script is plain JavaScript
  const { probePayDemRecord } = await import("../../scripts/probe-pay-dem-record.mjs");
  for (const change of [undefined, "failed", "amount"] as const) {
    const record = nodeRecord({ txHash: expected.hash, payer: expected.payer, payee: expected.payee,
      amountOs: change === "amount" ? "2" : expected.amountOs, status: change === "failed" ? "failed" : "confirmed" });
    const node = { nodeCall: async () => info, getTxByHash: async () => record };
    if (change === undefined) assert.equal((await probePayDemRecord(node, expected, version, approvedCommit)).state, "executed");
    else await assert.rejects(probePayDemRecord(node, expected, version, approvedCommit), /expected executed/);
  }
});

afterEach(() => vi.unstubAllGlobals());

test.skipIf(!existsSync(new URL("../../dist/rails/payDem.js", import.meta.url))).each([
  ["op%40example:p%3Ass", "op@example:p:ss"],
  ["operator:100%", "operator:100%"],
  ["op%FF:p%FFx", "op%FF:p%FFx"],
])("CLI reads version and records with Basic URL credentials %s", async (userinfo, decoded) => {
  const paths: string[] = [];
  const auth = `Basic ${Buffer.from(decoded, "utf8").toString("base64")}`;
  const record = nodeRecord({ txHash: expected.hash, payer: expected.payer, payee: expected.payee,
    amountOs: expected.amountOs });
  const server = createServer(async (req, res) => {
    paths.push(req.url!);
    if (req.headers.authorization !== auth) {
      res.writeHead(401).end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/version") res.end(JSON.stringify(version));
    else {
      let body = "";
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body).params[0].message;
      res.end(JSON.stringify({ result: 200, response: message === "getNetworkInfo" ? info : record }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const child = spawn(process.execPath, ["scripts/probe-pay-dem-record.mjs"], {
    cwd: new URL("../../", import.meta.url),
    env: { ...process.env, NO_PROXY: "127.0.0.1", DACS_RECORD_PROBE_FAILED_JSON: "",
      DACS_RECORD_PROBE_RPC: `http://${userinfo}@127.0.0.1:${address.port}/rpc?tenant=fixture`,
      DACS_RECORD_PROBE_CONFIRMED_JSON: JSON.stringify(expected), DACS_RECORD_PROBE_NODE_COMMIT: approvedCommit },
    stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const [code] = await once(child, "close");
    assert.equal(code, 0, stderr);
    assert.match(stdout, /"state":"executed"/);
    assert.deepEqual(paths, ["/version", "/rpc?tenant=fixture", "/rpc?tenant=fixture"]);
  } finally {
    child.kill();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test.skipIf(!existsSync(new URL("../../dist/rails/payDem.js", import.meta.url)))(
  "default CLI requires a current operator tuple before any network read", () => {
    const env = { ...process.env };
    delete env.DACS_RECORD_PROBE_CONFIRMED_JSON;
    const child = spawnSync(process.execPath, ["scripts/probe-pay-dem-record.mjs"], {
      cwd: new URL("../../", import.meta.url), env, encoding: "utf8", timeout: 5000,
    });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /DACS_RECORD_PROBE_CONFIRMED_JSON is required/);
  },
);

test.skipIf(!existsSync(new URL("../../dist/rails/payDem.js", import.meta.url)))(
  "deployment probe refuses unknown, changed or dirty source provenance before record reads", async () => {
    // @ts-expect-error the operational script is plain JavaScript
    const { probePayDemRecord } = await import("../../scripts/probe-pay-dem-record.mjs");
    for (const [servedVersion, nodeVersion, approved] of [
      [version, info.nodeVersion, undefined],
      [version, { ...info.nodeVersion, dirty: true }, approvedCommit],
      [version, { ...info.nodeVersion, commit: null }, approvedCommit],
      [{ commit: "unknown" }, info.nodeVersion, approvedCommit],
      [version, { ...info.nodeVersion, commit: "11".repeat(20) }, approvedCommit],
    ]) {
      const getTxByHash = vi.fn();
      await assert.rejects(probePayDemRecord({ nodeCall: async () => ({ ...info, nodeVersion }),
        getTxByHash }, expected, servedVersion, approved), /approved clean node build/);
      assert.equal(getTxByHash.mock.calls.length, 0);
    }
  },
);

test.skipIf(!existsSync(new URL("../../dist/rails/payDem.js", import.meta.url)))(
  "version reads reject oversized replies before decoding", async () => {
    // @ts-expect-error the operational script is plain JavaScript
    const { readProbeVersion } = await import("../../scripts/probe-pay-dem-record.mjs");
    vi.stubGlobal("fetch", async () => new Response("x".repeat(65537)));
    await assert.rejects(readProbeVersion("https://node.test"), /byte limit/);
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(65537)); },
      cancel() { throw new Error("cleanup failed"); },
    })));
    await assert.rejects(readProbeVersion("https://node.test"), /byte limit/);
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream({
      cancel() { throw new Error("cleanup failed"); },
    }), { status: 500 }));
    await assert.rejects(readProbeVersion("https://node.test"), /version HTTP 500/);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(version)));
    assert.deepEqual(await readProbeVersion("https://node.test"), version);
  },
);
