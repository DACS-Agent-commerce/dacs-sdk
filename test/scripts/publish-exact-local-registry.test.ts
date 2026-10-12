import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("publishes the exact archive under the acceptance dist-tag using installed libnpmpublish", async () => {
  const root = mkdtempSync(join(tmpdir(), "dacs-local-publish-"));
  let observed: { "dist-tags"?: Record<string, string> } | undefined;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    observed = JSON.parse(body);
    res.writeHead(201, { "content-type": "application/json" }); res.end('{}');
  });
  try {
    mkdirSync(join(root, "package"));
    writeFileSync(join(root, "package/package.json"), JSON.stringify({ name: "dacs-acceptance-test", version: "0.0.1" }));
    execFileSync("tar", ["-czf", join(root, "test.tgz"), "-C", root, "package"]);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const child = spawn(process.execPath, ["scripts/publish-exact-local-registry.mjs", join(root, "test.tgz"), `http://127.0.0.1:${address.port}`], {
      env: { ...process.env, DACS_LOCAL_REGISTRY_TOKEN: "acceptance-placeholder", NO_PROXY: "127.0.0.1" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = ""; child.stderr.on("data", d => stderr += d);
    const code = await new Promise(resolve => child.on("close", resolve));
    expect(code, stderr).toBe(0);
    expect(observed?.["dist-tags"]).toEqual({ acceptance: "0.0.1" });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
