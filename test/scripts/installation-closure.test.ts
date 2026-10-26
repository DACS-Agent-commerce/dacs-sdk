import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { cacheArchive, npmCi, packTarball, serveArchives, sri, tarArchive, type TarEntry } from "./npm-archive-fixtures.js";

// Keep the closure executable as plain Node ESM.
const closureModulePath = "../../scripts/installation-closure.mjs";
const { cachedArchive, packedFiles } = await import(closureModulePath);

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
  it("accepts a PAX size equal to the file header size", () => {
    const archive = gzipSync(tarArchive([{ ...valid, pax: { size: String(Buffer.byteLength(valid.body ?? "")) } }]));
    expect(text(packedFiles(archive))).toEqual({ "package.json": valid.body });
  });
  it.each(["00000000001", "00000002000"])("refuses a directory header with nonzero size %s", size => {
    const archive = gzipSync(tarArchive([valid, { name: "package/lib/", type: "5", size }]));
    expect(() => packedFiles(archive)).toThrow("packed tarball directory has a nonzero size");
  });
  it.each([
    ["entry data cut short", complete.subarray(0, 520), "truncated packed tarball entry"],
    ["entry padding cut short", complete.subarray(0, 600), "truncated packed tarball entry"],
    ["a size field that is not octal", tarArchive([{ ...valid, size: "0000000009x" }]), "malformed size"],
    ["no end-of-archive block", complete.subarray(0, 1024), "no end-of-archive block"],
    ["a header with a bad checksum", Buffer.concat([complete.subarray(0, 148), Buffer.from("0000000\0"), complete.subarray(156)]),
      "bad checksum"],
    ["a global pax header", tarArchive([valid, { name: "pax_global_header", type: "g", body: "" }]), "unsupported entry type g"],
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

