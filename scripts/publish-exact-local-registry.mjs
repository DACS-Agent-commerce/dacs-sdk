#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const [archivePath, registryValue] = process.argv.slice(2);
const token = process.env.DACS_LOCAL_REGISTRY_TOKEN;

if (!archivePath || !registryValue || !token) {
  throw new Error(
    "usage: DACS_LOCAL_REGISTRY_TOKEN=<token> publish-exact-local-registry.mjs <archive> <registry>",
  );
}

const registry = new URL(registryValue);
if (
  registry.protocol !== "http:" ||
  !["127.0.0.1", "localhost"].includes(registry.hostname)
) {
  throw new Error("exact local publisher only accepts a loopback HTTP registry");
}

const manifest = JSON.parse(
  execFileSync("tar", ["-xOf", archivePath, "package/package.json"], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  }),
);
const tarball = readFileSync(archivePath);

// npm's publish command intentionally lets publishConfig override CLI flags.
// Calling its pinned libnpmpublish implementation directly preserves the exact
// release tarball while disabling trusted publishing only for this disposable,
// loopback Verdaccio registry. The real npm release workflow still requires
// publishConfig.provenance=true and trusted publishing.
const npmRoot = execFileSync("npm", ["root", "--global"], {
  encoding: "utf8",
}).trim();
const require = createRequire(import.meta.url);
const { publish } = require(
  path.join(npmRoot, "npm", "node_modules", "libnpmpublish"),
);

await publish(manifest, tarball, {
  registry: registry.href,
  tag: "acceptance",
  access: "public",
  provenance: false,
  [`//${registry.host}/:_authToken`]: token,
});
