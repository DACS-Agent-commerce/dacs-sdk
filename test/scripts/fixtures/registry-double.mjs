// Test-only preload for scripts/publish-release-set.mjs: replaces fetch with an
// in-memory npm registry. The test directory (REGISTRY_DOUBLE_DIR) holds
// registry.json ({ releases, archives }), the stub npm's npm.log, and the
// fetch.log this preload appends to.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const directory = process.env.REGISTRY_DOUBLE_DIR;
const { releases, archives } = JSON.parse(readFileSync(join(directory, "registry.json"), "utf8"));
const npmLog = join(directory, "npm.log");

function publishedIntegrity(name) {
  if (!existsSync(npmLog)) return undefined;
  for (const line of readFileSync(npmLog, "utf8").split("\n")) {
    const [command, archivePath] = line.split(" ");
    if (command === "publish" && archives[archivePath]?.name === name) return archives[archivePath].integrity;
  }
  return undefined;
}

globalThis.fetch = async (url) => {
  appendFileSync(join(directory, "fetch.log"), `${url}\n`);
  const [, encodedName, encodedVersion] = new URL(url).pathname.split("/");
  const name = decodeURIComponent(encodedName);
  const integrity = releases[name] ?? publishedIntegrity(name);
  if (integrity === undefined) return new Response("{}", { status: 404 });
  return new Response(JSON.stringify({ name, version: decodeURIComponent(encodedVersion), dist: { integrity } }), { status: 200 });
};
