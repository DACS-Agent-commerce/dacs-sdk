// The packed core package carries what the wire guide names as its
// conformance material: the guide, the TP-1 declaration and register, and the
// vectors. npm itself lists the files; nothing is published or installed.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

it("the packed package ships the wire guide, the TP-1 declaration and register, and the wire vectors", () => {
  const run = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", timeout: 60_000 });
  expect(run.status, run.stderr).toBe(0);
  const [pack] = JSON.parse(run.stdout) as Array<{ files: Array<{ path: string }> }>;
  const files = pack!.files.map((f) => f.path);
  for (const name of ["docs/dacs-seller-http-v1.md", "docs/testnet-profile-tp1.md", "conformance/tp1-register.json", "vectors/dacs-seller-http-v1.json"]) {
    expect(files).toContain(name);
  }
});
