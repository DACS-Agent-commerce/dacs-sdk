// Package archives, npm's cache layout and real npm installations from a
// loopback archive server, for archive and installation tests.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

export const sri = (bytes: Buffer) => "sha512-" + createHash("sha512").update(bytes).digest("base64");

/** One tar entry: `type` defaults to a file ("0"); `pax` precedes it with a pax header; `size` replaces its size field. */
export type TarEntry = { name: string; body?: string; type?: string; pax?: Record<string, string>; size?: string; prefix?: string; magic?: string };

function tarHeader(name: string, size: number, type: string, sizeField = size.toString(8).padStart(11, "0"), prefix = "", magic = "ustar\0" + "00") {
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write("0000644\0", 100);
  header.write(sizeField + "\0", 124);
  header.write("        ", 148);
  header.write(type, 156);
  if (type === "1" || type === "2") header.write("index.js", 157);
  header.write(magic, 257);
  header.write(prefix, 345);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
  return header;
}

function tarBlocks(name: string, body: Buffer, type: string, sizeField?: string, prefix?: string, magic?: string) {
  return [tarHeader(name, body.length, type, sizeField, prefix, magic), body, Buffer.alloc((512 - (body.length % 512)) % 512)];
}

/** An uncompressed tar of `entries`, ending in the two zero blocks of a complete archive. */
export function tarArchive(entries: TarEntry[]) {
  const blocks: Buffer[] = [];
  for (const { name, body = "", type = "0", pax, size, prefix, magic } of entries) {
    if (pax) {
      const records = Object.entries(pax).map(([key, value]) => {
        const record = ` ${key}=${value}\n`;
        let length = record.length + 1;
        while (`${length}${record}`.length !== length) length += 1;
        return `${length}${record}`;
      }).join("");
      blocks.push(...tarBlocks("PaxHeader", Buffer.from(records), "x"));
    }
    blocks.push(...tarBlocks(name.slice(0, 100), Buffer.from(body), type, size, prefix, magic));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

/** A gzip-compressed npm package archive holding `files` below `package/`. */
export function packTarball(files: Record<string, string>) {
  return gzipSync(tarArchive(Object.entries(files).map(([path, body]) => ({ name: `package/${path}`, body }))));
}

/** Stores `archive` in npm's content-addressed cache below `cache`, as npm ci does, and returns its path. */
export function cacheArchive(cache: string, archive: Buffer) {
  const hex = createHash("sha512").update(archive).digest("hex");
  const path = join(cache, "_cacache", "content-v2", "sha512", hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, archive);
  return path;
}

/** Serves each archive at `<registry>/<name>.tgz` on a loopback port until `close`. */
export async function serveArchives(archives: Map<string, Buffer>) {
  const server = createServer((request, response) => {
    const archive = archives.get(decodeURIComponent((request.url ?? "").slice(1).replace(/\.tgz$/, "")));
    response.writeHead(archive ? 200 : 404, { "content-type": "application/octet-stream" });
    response.end(archive ?? "");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { registry, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

/** The npm CLI entry running these tests, or the one on PATH. */
export const npmCli = process.env.npm_execpath
  ? join(dirname(process.env.npm_execpath), "npm-cli.js")
  : join(execFileSync("npm", ["root", "--global"], { encoding: "utf8" }).trim(), "npm/bin/npm-cli.js");

/** Runs `npm ci --ignore-scripts` in `project` against `registry`, with npm's cache in `cache`. */
export function npmCi(project: string, registry: string, cache: string) {
  const args = [npmCli, "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--no-update-notifier", "--registry", registry];
  return new Promise<{ status: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: project, env: { ...process.env, npm_config_cache: cache } });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    child.on("error", reject);
    child.on("close", status => resolve({ status, output }));
  });
}
