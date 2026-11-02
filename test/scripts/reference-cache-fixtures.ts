import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packTarball, sri } from "./npm-archive-fixtures.js";
const closurePath = "../../scripts/installation-closure.mjs";
const { cachedArchive, npmToolchain } = await import(closurePath);
const referencePath = "../../scripts/reference-installation.mjs";
const { npmInstallContract } = await import(referencePath);
const run = (project: string, args: string[]) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
  const toolchain = npmToolchain();
  const child = spawn(toolchain.node, [toolchain.cli, ...args, `--cache=${join(project, "cache")}`], { cwd: project });
  let output = "";
  child.stdout.on("data", bytes => { output += bytes; });
  child.stderr.on("data", bytes => { output += bytes; });
  child.on("error", reject);
  child.on("close", code => resolve({ code, output }));
});

// A real installer cache has packuments as well as archives. Optional subtrees
// contain incompatible peers that npm re-resolves even with omit=optional.
export async function peerCacheFixture(project: string, extra: { name: string; version: string }[] = []) {
  const cache = join(project, "cache");
  const packages = [
    { name: "d", version: "1.0.0", dependencies: { t: "2.0.0", c: "3.0.0" }, optionalDependencies: { o: "1.0.0" } },
    { name: "o", version: "1.0.0", dependencies: { t: "1.0.0", c: "^1.0.0" } },
    { name: "t", version: "1.0.0", peerDependencies: { c: ">=2 <4" } },
    { name: "t", version: "2.0.0", peerDependencies: { c: ">=3 <4" } },
    ...[1, 2, 3].map(version => ({ name: "c", version: `${version}.0.0` })),
    ...extra,
  ];
  const archives = new Map(packages.map(pkg => [`/${pkg.name}-${pkg.version}.tgz`, packTarball({ "package.json": JSON.stringify(pkg) })]));
  let registry = "";
  const server = createServer((request, response) => {
    const path = decodeURIComponent(request.url ?? "");
    const archive = archives.get(path);
    if (archive) { response.end(archive); return; }
    const versions = packages.filter(pkg => path === `/${pkg.name}`).map(pkg => {
      const tarball = `/${pkg.name}-${pkg.version}.tgz`;
      const bytes = archives.get(tarball);
      if (!bytes) throw Error("missing fixture archive");
      return [pkg.version, { ...pkg, dist: { tarball: registry + tarball, integrity: sri(bytes) } }];
    });
    response.writeHead(versions.length ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: path.slice(1), "dist-tags": { latest: versions.at(-1)?.[0] }, versions: Object.fromEntries(versions) }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "consumer", version: "1.0.0", dependencies: { d: "1.0.0", ...Object.fromEntries(extra.map(pkg => [pkg.name, pkg.version])) } }));
  writeFileSync(join(project, ".npmrc"), `registry=${registry}\ncache=${cache}\nomit=optional\n`);
  try {
    const installed = await run(project, ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
    if (installed.code !== 0) throw Error(installed.output);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  const offline = await run(project, ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"]);
  if (offline.code !== 0) throw Error(offline.output);
  return { project, registry, archives, input: { manifest: readFileSync(join(project, "package.json")),
    lock: JSON.parse(readFileSync(join(project, "package-lock.json"), "utf8")), installer: npmInstallContract(project),
    metadataCache: cache, readArchive: (_location: string, entry: { integrity: string }) => cachedArchive(cache, entry.integrity) } };
}

