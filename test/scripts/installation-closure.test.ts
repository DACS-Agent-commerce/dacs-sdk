import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { cacheArchive, npmCi, packTarball, serveArchives, sri, tarArchive, type TarEntry } from "./npm-archive-fixtures.js";

// Keep the closure executable as plain Node ESM.
const closureModulePath = "../../scripts/installation-closure.mjs";
const { ARCHIVE_LIMITS, cachedArchive, npmToolchain, packedFileSets, packedFiles, runNpmNode, verifyArchive } = await import(closureModulePath);

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const temporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), "dacs-installation-closure-"));
  scratch.push(directory);
  return directory;
};
const manifest = (name: string, version = "1.0.0", fields: Record<string, unknown> = {}) =>
  JSON.stringify({ name, version, ...fields });
const text = (files: Map<string, Buffer>) => Object.fromEntries([...files].map(([path, bytes]) => [path, bytes.toString()]));

describe("packed archive files", () => {
  it("installs file entries below the first path component and skips directories and links, as npm does", () => {
    const archive = gzipSync(tarArchive([
      { name: "package/", type: "5" },
      { name: "package/package.json", body: manifest("a") },
      { name: "package/lib/", type: "5" },
      { name: "package/lib/index.js", body: "module.exports = 1;\n" },
      { name: "package/link.js", type: "2" },
      { name: "package/.gitignore", body: "dist\n" },
      { name: "package/docs/.gitignore", body: "draft\n" },
      { name: "package/docs/.npmignore", body: "notes\n" },
    ]));
    expect(text(packedFiles(archive))).toEqual({ "package.json": manifest("a"), "lib/index.js": "module.exports = 1;\n",
      ".npmignore": "dist\n", "docs/.npmignore": "notes\n" });
  });

  it("matches a real npm installation that normalizes dot segments after stripping one component", async () => {
    const archive = gzipSync(tarArchive([
      { name: "package/./package.json", body: manifest("dots") },
      { name: "package/./index.js", body: "module.exports = 1;\n" },
      { name: "package/lib/./nested.js", body: "nested" },
      { name: "package/./lib2/./multiple.js", body: "multiple" },
      { name: "./package/leading.js", body: "strip before resolving" },
    ]));
    const expected = { "package.json": manifest("dots"), "index.js": "module.exports = 1;\n",
      "lib/nested.js": "nested", "lib2/multiple.js": "multiple", "package/leading.js": "strip before resolving" };
    const project = temporaryDirectory();
    const server = await serveArchives(new Map([["dots", archive]]));
    try {
      const root = { name: "consumer", version: "1.0.0", dependencies: { dots: "1.0.0" } };
      writeFileSync(join(project, "package.json"), JSON.stringify(root));
      writeFileSync(join(project, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {
        "": root, "node_modules/dots": { version: "1.0.0", resolved: `${server.registry}/dots.tgz`, integrity: sri(archive) },
      } }));
      const installed = await npmCi(project, server.registry, join(project, ".npm"));
      expect(installed.status, installed.output).toBe(0);
      for (const [path, content] of Object.entries(expected)) {
        expect(readFileSync(join(project, "node_modules/dots", path), "utf8")).toBe(content);
      }
      expect(text(packedFiles(archive))).toEqual(expected);
    } finally { await server.close(); }
  }, 60_000);

  it.each([false, true])("refuses canonical duplicate paths with dot segments, reverse=%s", reverse => {
    const entries = [{ name: "package/index.js", body: "first" }, { name: "package/./index.js", body: "second" }];
    if (reverse) entries.reverse();
    expect(() => packedFiles(gzipSync(tarArchive([{ name: "package/package.json", body: manifest("a") }, ...entries]))))
      .toThrow("duplicate packed tarball entry");
  });

  it.each([false, true])("refuses canonical file/ancestor conflicts with dot segments, reverse=%s", reverse => {
    const entries = [{ name: "package/./a", body: "file" }, { name: "package/a/./b", body: "child" }];
    if (reverse) entries.reverse();
    expect(() => packedFiles(gzipSync(tarArchive([{ name: "package/package.json", body: manifest("a") }, ...entries]))))
      .toThrow("file/ancestor conflict");
  });

  it.each(["package/./../escape.js", "package/./a/../../escape.js", "package/./\\escape.js"])(
    "refuses an escaping path containing dot segments: %s", name => {
      expect(() => packedFiles(gzipSync(tarArchive([{ name: "package/package.json", body: manifest("a") }, { name }]))))
        .toThrow("escapes the package");
    });

  it.each([
    ["a pax path record", [{ name: "package/short", body: "long", pax: { path: `package/${"d/".repeat(60)}file.js` } }]],
    ["a GNU long-name entry", [{ name: "././@LongLink", type: "L", body: `package/${"d/".repeat(60)}file.js\0` },
      { name: "package/short", body: "long" }]],
  ])("takes a long name from %s", (_form, entries: TarEntry[]) => {
    const files = packedFiles(gzipSync(tarArchive([{ name: "package/package.json", body: manifest("a") }, ...entries])));
    expect(files.get(`${"d/".repeat(60)}file.js`)?.toString()).toBe("long");
  });

  const valid: TarEntry = { name: "package/package.json", body: manifest("a") };
  const complete = tarArchive([valid]);
  it.each([1, 2, 4])("accepts an archive ending in %i zero tar blocks", blocks => {
    const tar = Buffer.concat([complete.subarray(0, -1024), Buffer.alloc(blocks * 512)]);
    expect(text(packedFiles(gzipSync(tar)))).toEqual({ "package.json": valid.body });
  });
  it.each([1, 2, 4])("refuses file entries after %i zero tar blocks", blocks => {
    const tar = Buffer.concat([complete.subarray(0, -1024), Buffer.alloc(blocks * 512),
      tarArchive([{ name: "package/late.js", body: "module.exports = 42;\n" }])]);
    expect(() => packedFiles(gzipSync(tar))).toThrow("packed tarball has a malformed trailer");
  });
  it("refuses nonzero trailing bytes after the archive terminator", () => {
    expect(() => packedFiles(gzipSync(Buffer.concat([complete, Buffer.from([1])]))))
      .toThrow("packed tarball has a malformed trailer");
  });
  it("uses npm's handling of an empty global PAX header", () => {
    expect(text(packedFiles(gzipSync(tarArchive([valid, { name: "pax_global_header", type: "g" }])))))
      .toEqual({ "package.json": valid.body });
  });
  it("accepts a legacy regular-file directory marker as npm does", () => {
    expect(text(packedFiles(gzipSync(tarArchive([valid, { name: "package/lib/", type: "0" }])))))
      .toEqual({ "package.json": valid.body });
  });
  it("accepts a PAX size equal to the file header size", () => {
    const archive = gzipSync(tarArchive([{ ...valid, pax: { size: String(Buffer.byteLength(valid.body ?? "")) } }]));
    expect(text(packedFiles(archive))).toEqual({ "package.json": valid.body });
  });
  it.each(["00000000001", "00000002000"])("refuses a directory header with nonzero size %s", size => {
    const archive = gzipSync(tarArchive([valid, { name: "package/lib/", type: "5", size }]));
    expect(() => packedFiles(archive)).toThrow("packed tarball directory has a nonzero size");
  });
  it.each(["1", "2"])("matches npm for link type %s with a body covering the next file header", async type => {
    const tar = Buffer.concat([tarArchive([valid, { name: "package/link", type, size: "00000002000" }]).subarray(0, -1024),
      tarArchive([{ name: "package/hidden.js", body: "hidden" }])]);
    const archive = gzipSync(tar);
    const directory = temporaryDirectory();
    const path = join(directory, "archive.tgz");
    const expected = join(directory, "expected");
    writeFileSync(path, archive);
    await createRequire(npmToolchain().cli)("pacote").extract(path, expected,
      { offline: true, ignoreScripts: true, cache: join(directory, "cache") });
    const files = packedFiles(archive);
    expect([...files.keys()].sort()).toEqual(readdirSync(expected).sort());
    for (const [name, bytes] of files) expect(bytes).toEqual(readFileSync(join(expected, name)));
  });
  it.each([
    ["entry data cut short", complete.subarray(0, 520), "Truncated input"],
    ["entry padding cut short", complete.subarray(0, 600), "Truncated input"],
    ["a size field that is not octal", tarArchive([{ ...valid, size: "0000000009x" }]), "malformed size"],
    ["no end-of-archive block", complete.subarray(0, 1024), "no end-of-archive block"],
    ["a header with a bad checksum", Buffer.concat([complete.subarray(0, 148), Buffer.from("0000000\0"), complete.subarray(156)]),
      "checksum failure"],
    ["a parent-directory path", tarArchive([valid, { name: "package/../escape.js" }]), "escapes the package"],
    ["an empty path segment", tarArchive([valid, { name: "package//double.js" }]), "escapes the package"],
    ["an absolute path", tarArchive([valid, { name: "/package/absolute.js" }]), "escapes the package"],
    ["a duplicate path", tarArchive([valid, valid]), "duplicate packed tarball entry"],
    ["a differing pax size record", tarArchive([valid, { name: "package/sized.js", pax: { size: "1" } }]), "pax size differs from the entry header"],
    ["a malformed pax size record", tarArchive([valid, { name: "package/sized.js", pax: { size: "1x" } }]), "malformed pax size"],
    ["no package.json", tarArchive([{ name: "package/index.js" }]), "no package.json"],
  ])("refuses an archive with %s", (_form, tar, message) => {
    expect(() => packedFiles(gzipSync(tar))).toThrow(message);
  });
});

describe("cached package archives", () => {
  const archive = packTarball({ "package.json": manifest("a") });
  it("reads an archive from npm's cache by its sha512 integrity", () => {
    const cache = temporaryDirectory();
    cacheArchive(cache, archive);
    expect(cachedArchive(cache, sri(archive)).equals(archive)).toBe(true);
  });
  it("refuses a missing archive, keeping the cause", () => {
    expect(() => cachedArchive(temporaryDirectory(), sri(archive))).toThrow(/cannot read npm's cached archive .*\(ENOENT\)/);
  });
  it("refuses cached bytes with another digest", () => {
    const cache = temporaryDirectory();
    writeFileSync(cacheArchive(cache, archive), packTarball({ "package.json": manifest("b") }));
    expect(() => cachedArchive(cache, sri(archive))).toThrow("does not match its integrity");
  });
  it.each(["sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=", `${sri(archive)} ${sri(Buffer.from("other"))}`, undefined])(
    "refuses an integrity without exactly one sha512 digest: %s", integrity => {
      expect(() => cachedArchive(temporaryDirectory(), integrity)).toThrow("no single sha512 digest");
    });
});


describe("file and ancestor conflicts (D-1)", () => {
  const archive = gzipSync(tarArchive([
    { name: "package/package.json", body: manifest("collision") },
    { name: "package/a/b", body: "child" },
    { name: "package/a", body: "file" },
  ]));
  it("refuses a file that is also an ancestor of another file", () => {
    expect(() => packedFiles(archive)).toThrow(/conflict|ENOTEMPTY/);
  });
  it("refuses the ambiguous archive even when real npm exits successfully", async () => {
    const project = temporaryDirectory();
    const server = await serveArchives(new Map([["collision", archive]]));
    try {
      const root = { name: "consumer", version: "1.0.0", dependencies: { collision: "1.0.0" } };
      writeFileSync(join(project, "package.json"), JSON.stringify(root));
      writeFileSync(join(project, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {
        "": root, "node_modules/collision": { version: "1.0.0", resolved: `${server.registry}/collision.tgz`, integrity: sri(archive) },
      } }));
      const installed = await npmCi(project, server.registry, join(project, ".npm"));
      expect(installed.status, installed.output).toBe(0);
      expect(installed.output).toContain("ENOTEMPTY");
      expect(readFileSync(join(project, "node_modules/collision/a/b"), "utf8")).toBe("child");
      expect(() => packedFiles(archive)).toThrow(/conflict|ENOTEMPTY/);
    } finally { await server.close(); }
  }, 60_000);
});


describe("bounded archive operations", () => {
  const toolchain = npmToolchain();
  const archive = packTarball({ "package.json": manifest("a") });
  it("authenticates callback bytes independently of their reader", () => {
    expect(verifyArchive(archive, sri(archive))).toEqual(archive);
    expect(() => verifyArchive(Buffer.from("different"), sri(archive))).toThrow("does not match its integrity");
  });
  it("enforces the compressed byte boundary before decoding", () => {
    expect(() => packedFiles(archive, toolchain, { archiveBytes: archive.length - 1 })).toThrow("larger than");
    expect(packedFiles(archive, toolchain, { archiveBytes: archive.length }).has("package.json")).toBe(true);
  });
  it("enforces the unpacked byte boundary during decoding", () => {
    const tar = tarArchive([{ name: "package/package.json", body: manifest("a") }]);
    expect(() => packedFiles(gzipSync(tar), toolchain, { unpackedBytes: tar.length - 1 })).toThrow();
    expect(packedFiles(gzipSync(tar), toolchain, { unpackedBytes: tar.length }).has("package.json")).toBe(true);
  });
  it("enforces the entry-count boundary", () => {
    expect(packedFiles(archive, toolchain, { entries: 1 }).has("package.json")).toBe(true);
    expect(() => packedFiles(packTarball({ "package.json": manifest("a"), extra: "" }), toolchain, { entries: 1 }))
      .toThrow("more than 1 entries");
  });
  it("bounds a sparse cached file before reading its bytes", () => {
    const cache = temporaryDirectory();
    truncateSync(cacheArchive(cache, archive), ARCHIVE_LIMITS.archiveBytes + 1);
    expect(() => cachedArchive(cache, sri(archive))).toThrow("larger than");
  });
  it("keeps the timeout cause and bounds subprocess output", () => {
    expect(() => runNpmNode(toolchain, ["-e", "setInterval(() => {}, 1000)"], {}, { timeout: 20 })).toThrow("ETIMEDOUT");
    expect(() => runNpmNode(toolchain, ["-e", "process.stdout.write('x'.repeat(4096))"], {}, { outputBytes: 1024 }))
      .toThrow("ENOBUFS");
  });
  it("rejects limits exceeding the hard ceilings", () => {
    expect(() => packedFiles(archive, toolchain, { entries: ARCHIVE_LIMITS.entries + 1 })).toThrow("invalid archive limit");
  });
  it("bounds path bytes before splitting, including multibyte paths", () => {
    const packed = (path: string) => gzipSync(tarArchive([
      { name: "package/package.json", body: manifest("a") }, { name: path, body: "file" },
    ]));
    expect(packedFiles(packed(`package/${"x".repeat(56)}`), toolchain, { pathBytes: 64 }).size).toBe(2);
    for (const path of [`package/${"x".repeat(57)}`, `package/${"é".repeat(29)}`]) {
      expect(() => packedFiles(packed(path), toolchain, { pathBytes: 64 })).toThrow("path exceeds byte limit");
    }
  });
  it("bounds path depth before building the package namespace", () => {
    const packed = (path: string) => gzipSync(tarArchive([
      { name: "package/package.json", body: manifest("a") }, { name: path, body: "file" },
    ]));
    expect(packedFiles(packed("package/a/b/c"), toolchain, { pathDepth: 4 }).size).toBe(2);
    expect(() => packedFiles(packed("package/a/b/c/d"), toolchain, { pathDepth: 4 })).toThrow("path exceeds depth limit");
  });
  it("refuses a shared deep PAX namespace before constructing ancestors", () => {
    const prefix = `package/${"d/".repeat(200_000)}`;
    const archive = gzipSync(tarArchive([{ name: "package/package.json", body: manifest("a") },
      ...Array.from({ length: 120 }, (_, index) => ({ name: "package/short", body: "file", pax: { path: `${prefix}${index}.js` } })),
    ]));
    expect(() => packedFiles(archive, toolchain)).toThrow("path exceeds byte limit");
  });
  const parserToolchain = (source: string) => {
    const npmRoot = join(temporaryDirectory(), "npm");
    mkdirSync(join(npmRoot, "bin"), { recursive: true });
    mkdirSync(join(npmRoot, "node_modules/tar"), { recursive: true });
    writeFileSync(join(npmRoot, "bin/npm-cli.js"), "");
    writeFileSync(join(npmRoot, "node_modules/tar/index.js"), source);
    const real = createRequire(toolchain.cli);
    symlinkSync(dirname(real.resolve("pacote/package.json")), join(npmRoot, "node_modules/pacote"));
    return { ...toolchain, cli: join(npmRoot, "bin/npm-cli.js") };
  };
  it("runs archive validation inside the extraction subprocess", () => {
    const real = createRequire(toolchain.cli);
    const isolated = parserToolchain(`const tar = require(${JSON.stringify(real.resolve("tar"))});
      module.exports = { Parser: class extends (tar.Parser ?? tar.Parse) {
        constructor(options) {
          if (process.pid === ${process.pid}) throw Error('parser ran in caller');
          super(options);
        }
      } };`);
    expect(packedFiles(archive, isolated).has("package.json")).toBe(true);
  });
  it("applies the worker deadline to stalled archive validation", () => {
    const stalled = parserToolchain(`module.exports = { Parser: class {
      constructor() {
        if (process.pid === ${process.pid}) throw Error('parser ran in caller');
        while (true) {}
      }
    } };`);
    expect(() => packedFiles(archive, stalled, { timeout: 200 })).toThrow("ETIMEDOUT");
  });
  it("gives extraction its full deadline after the validation worker completes", () => {
    const probe = `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const original = childProcess.execFileSync;
      const calls = [];
      childProcess.execFileSync = (node, args, options) => {
        const result = original(node, args, options);
        calls.push({ phase: args[3], timeout: options.timeout });
        return result;
      };
      syncBuiltinESMExports();
      const { packedFiles } = await import(${JSON.stringify(new URL(closureModulePath, import.meta.url).href)});
      packedFiles(Buffer.from(${JSON.stringify(archive.toString("base64"))}, 'base64'), ${JSON.stringify(toolchain)});
      process.stdout.write(JSON.stringify(calls));
    `;
    const calls = JSON.parse(runNpmNode(toolchain, ["--input-type=module", "-e", probe], { encoding: "utf8" }));
    expect(calls).toEqual([{ phase: "validate", timeout: ARCHIVE_LIMITS.timeout },
      { phase: "extract", timeout: ARCHIVE_LIMITS.timeout }]);
  });
  it.each([false, true])("refuses file/ancestor conflicts in either archive order, reverse=%s", reverse => {
    const entries = [{ name: "package/a", body: "file" }, { name: "package/a/b", body: "child" }];
    if (reverse) entries.reverse();
    expect(() => packedFiles(gzipSync(tarArchive([{ name: "package/package.json", body: manifest("a") }, ...entries]))))
      .toThrow("file/ancestor conflict");
  });
});


it.each(["ustar\0" + "00", ""]) ("delegates ustar prefix handling to npm, magic=%j", magic => {
  const files = packedFiles(gzipSync(tarArchive([
    { name: "package/package.json", body: manifest("a") },
    { name: "package/short.js", prefix: "package/long/path", magic, body: "content" },
  ])));
  expect(files.has(magic ? "long/path/package/short.js" : "short.js")).toBe(true);
});


it("reads archives with the tar 6 parser name bundled with npm 10.8", () => {
  const toolchain = npmToolchain();
  const real = createRequire(toolchain.cli);
  const npmRoot = join(temporaryDirectory(), "npm");
  mkdirSync(join(npmRoot, "bin"), { recursive: true });
  mkdirSync(join(npmRoot, "node_modules/tar"), { recursive: true });
  writeFileSync(join(npmRoot, "bin/npm-cli.js"), "");
  writeFileSync(join(npmRoot, "node_modules/tar/index.js"),
    `const tar = require(${JSON.stringify(real.resolve("tar"))}); module.exports = { Parse: tar.Parser ?? tar.Parse };`);
  symlinkSync(dirname(real.resolve("pacote/package.json")), join(npmRoot, "node_modules/pacote"));
  const files = packedFiles(packTarball({ "package.json": manifest("a") }), { ...toolchain, cli: join(npmRoot, "bin/npm-cli.js") });
  expect(text(files)).toEqual({ "package.json": manifest("a") });
});

it("extracts multiple independent sources and publishes no partial result", () => {
  const sources = new Map([["a", packTarball({ "package.json": manifest("a"), "index.js": "a" })],
    ["b", packTarball({ "package.json": manifest("b"), "index.js": "b" })]]);
  const files = packedFileSets(sources);
  expect(files.get("a").get("index.js").toString()).toBe("a");
  expect(files.get("b").get("index.js").toString()).toBe("b");
  sources.set("b", Buffer.from("invalid"));
  expect(() => packedFileSets(sources)).toThrow("cannot extract archive b");
});
