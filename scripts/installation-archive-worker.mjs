// All downloaded archive processing runs under the caller's subprocess deadline.
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix } from "node:path";
import { gunzipSync } from "node:zlib";

const TAR_BLOCK = 512;
const FILE_TYPES = new Set(["File", "OldFile", "ContiguousFile"]);
const SKIPPED_TYPES = new Set(["Link", "SymbolicLink", "CharacterDevice", "BlockDevice", "Directory", "FIFO"]);

function boundPath(name, limits) {
  if (name.length > limits.pathBytes || Buffer.byteLength(name) > limits.pathBytes) {
    throw new Error("packed tarball path exceeds byte limit");
  }
  let depth = 1;
  for (const character of name) {
    if (character === "/" && ++depth > limits.pathDepth) throw new Error("packed tarball path exceeds depth limit");
  }
}

// npm strips one archive component before resolving the extraction destination.
function packagePath(name) {
  const parts = name.split("/").slice(1);
  const stripped = parts.join("/");
  if (posix.isAbsolute(name) || posix.isAbsolute(stripped) || parts.includes("..") || name.includes("\\")) {
    throw new Error("packed tarball entry escapes the package: " + name);
  }
  return posix.normalize(stripped);
}

// One bounded trie insertion detects duplicate and ancestor conflicts in either order.
function addFile(namespace, parts, name) {
  let node = namespace;
  for (const part of parts) {
    if (node.file) throw new Error("packed tarball file/ancestor conflict: " + name);
    if (!node.children.has(part)) node.children.set(part, { children: new Map(), file: false });
    node = node.children.get(part);
  }
  if (node.file) throw new Error("duplicate packed tarball entry: " + name);
  if (node.children.size) throw new Error("packed tarball file/ancestor conflict: " + name);
  node.file = true;
}

// The trusted parser advances its own cursor. We feed fixed blocks solely to
// observe its terminator event and refuse any later nonzero bytes.
function validateFraming(tar, tarModule, limits) {
  // npm 10.8 and earlier bundle tar 6, which names the parser class `Parse`.
  const Parser = tarModule.Parser ?? tarModule.Parse;
  let block;
  let terminated = false;
  let entries = 0;
  const files = new Set();
  const namespace = { children: new Map(), file: false };
  const count = () => {
    if (++entries > limits.entries) throw new Error(`packed tarball has more than ${limits.entries} entries`);
  };
  const parser = new Parser({
    onwarn: (code, message) => { throw new Error(`packed tarball ${code}: ${message}`); },
    filter: (name, entry) => {
      count();
      boundPath(name, limits);
      const rawSize = block.toString("ascii", 124, 136).replace(/\0.*$/s, "").trim();
      if (!/^[0-7]*$/.test(rawSize)) throw new Error("packed tarball entry has a malformed size");
      const size = Number.parseInt(rawSize || "0", 8);
      if (entry.type === "Directory" && size !== 0) throw new Error("packed tarball directory has a nonzero size");
      if (entry.type !== "Directory" && size !== entry.size) throw new Error("pax size differs from the entry header in the packed tarball");
      if (SKIPPED_TYPES.has(entry.type)) return false;
      if (!FILE_TYPES.has(entry.type)) throw new Error("unsupported entry type in the packed tarball: " + entry.type);
      const path = packagePath(name);
      if (path === ".") return false;
      addFile(namespace, path.split("/"), name);
      files.add(path);
      return true;
    },
  });
  parser.on("entry", entry => entry.resume());
  parser.on("ignoredEntry", entry => { if (entry.meta) throw new Error("packed tarball metadata is too large"); });
  parser.on("meta", data => {
    count();
    for (const match of data.matchAll(/(?:^|\n)\d+ size=([^\n]*)\n/g)) {
      if (!/^(0|[1-9][0-9]*)$/.test(match[1])) throw new Error("malformed pax size in the packed tarball");
    }
  });
  parser.on("nullBlock", () => { terminated = true; });
  for (let offset = 0; offset < tar.length; offset += TAR_BLOCK) {
    block = tar.subarray(offset, offset + TAR_BLOCK);
    if (terminated) {
      if (block.some(byte => byte !== 0)) throw new Error("packed tarball has a malformed trailer");
    } else parser.write(block);
  }
  parser.end();
  if (!terminated) throw new Error("truncated packed tarball: no end-of-archive block");
  if (!files.has("package.json")) throw new Error("packed tarball has no package.json");
}

function extractedPaths(destination) {
  const paths = [];
  const visit = directory => {
    for (const item of readdirSync(join(destination, directory), { withFileTypes: true })) {
      const path = directory ? `${directory}/${item.name}` : item.name;
      if (item.isDirectory()) visit(path);
      else if (item.isFile() && lstatSync(join(destination, path)).nlink === 1) paths.push(path);
      else throw new Error("unexpected extracted entry: " + path);
    }
  };
  visit("");
  if (!paths.includes("package.json")) throw new Error("packed tarball has no package.json");
  return paths;
}

const [cli, scratch, phase] = process.argv.slice(2);
const { limits, labels } = JSON.parse(readFileSync(join(scratch, "sources.json"), "utf8"));
process.on("log", (level, title, ...messages) => {
  if (level === "warn" || level === "error") throw new Error(title + ": " + messages.join(" "));
});
try {
  const require = createRequire(cli);
  const pacote = phase === "extract" ? require("pacote") : null;
  const tarModule = phase === "validate" ? require("tar") : null;
  const results = [];
  for (const [index, label] of labels.entries()) {
    try {
      const archive = join(scratch, index + ".tgz");
      if (phase === "validate") {
        const tar = gunzipSync(readFileSync(archive), { maxOutputLength: limits.unpackedBytes });
        validateFraming(tar, tarModule, limits);
      } else {
        const destination = join(scratch, "package-" + index);
        await pacote.extract(archive, destination, { offline: true, ignoreScripts: true, cache: join(scratch, "cache") });
        results.push(extractedPaths(destination));
      }
    } catch (cause) { throw new Error(`cannot extract archive ${label}: ${cause.message}`, { cause }); }
  }
  if (phase === "extract") writeFileSync(join(scratch, "files.json"), JSON.stringify(results));
} catch (cause) {
  writeFileSync(join(scratch, "failure.json"), JSON.stringify({ message: cause.message }));
  process.exitCode = 1;
}
