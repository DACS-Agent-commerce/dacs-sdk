import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

// Plain Node ESM script; a computed import keeps it out of the TypeScript program.
const publisherModulePath = "../../scripts/publish-exact-local-registry.mjs";
const { publishExactLocalRegistry, loadPinnedLibnpmpublish, readPackedManifest, PINNED_ACCEPTANCE_NPM_VERSION } =
  await import(publisherModulePath);

const scratch: string[] = [];
afterEach(() => { for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function tempDirectory(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(directory);
  return directory;
}

// A minimal ustar + gzip writer, so no host `tar` is involved.
function packTarball(entries: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(entries)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148); header.write("0", 156); header.write("ustar\0" + "00", 257);
    let sum = 0; for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

const sri = (bytes: Buffer) => "sha512-" + createHash("sha512").update(bytes).digest("base64");
const REGISTRY = "http://127.0.0.1:4873";

function candidate(name = "@kynesyslabs/dacs", version = "0.1.0-test") {
  const directory = tempDirectory("dacs-local-publish-");
  const archivePath = join(directory, "candidate.tgz");
  const bytes = packTarball({ "package/README.md": "readme\n", "package/package.json": JSON.stringify({ name, version }) });
  writeFileSync(archivePath, bytes);
  return { archivePath, bytes, name, version };
}

// Injected registry: records the publish call and serves a packument.
function fakeRegistry(packument: (published: { manifest: { name: string; version: string }; tarball: Buffer }) => unknown) {
  const calls: { manifest: { name: string; version: string }; tarball: Buffer; options: Record<string, unknown> }[] = [];
  const urls: string[] = [];
  return {
    calls, urls,
    publish: async (manifest: { name: string; version: string }, tarball: Buffer, options: Record<string, unknown>) => {
      calls.push({ manifest, tarball, options });
    },
    fetch: async (url: URL) => {
      urls.push(String(url));
      return { ok: true, status: 200, json: async () => packument(calls[0]!) };
    },
  };
}
const onlyCandidate = ({ manifest, tarball }: { manifest: { version: string }; tarball: Buffer }) =>
  ({ versions: { [manifest.version]: { dist: { integrity: sri(tarball) } } } });

describe("exact local registry publisher", () => {
  it("publishes the exact archive bytes under the acceptance dist-tag without provenance", async () => {
    const { archivePath, bytes, name, version } = candidate();
    const registry = fakeRegistry(onlyCandidate);
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "acceptance-placeholder", ...registry }))
      .resolves.toEqual({ name, version, integrity: sri(bytes) });
    expect(registry.calls).toHaveLength(1);
    const [call] = registry.calls;
    expect(call!.manifest).toEqual({ name, version });
    expect(Buffer.compare(call!.tarball, bytes)).toBe(0);
    expect(call!.options).toEqual({ registry: REGISTRY + "/", defaultTag: "acceptance", access: "public", provenance: false,
      "//127.0.0.1:4873/:_authToken": "acceptance-placeholder" });
    expect(registry.urls).toEqual([`${REGISTRY}/@kynesyslabs%2fdacs`]);
  });

  it("preserves packed publishConfig while explicitly disabling local provenance", async () => {
    const archivePath = join(tempDirectory("dacs-local-config-"), "candidate.tgz");
    const manifest = { name: "@kynesyslabs/dacs", version: "0.1.0-test",
      publishConfig: { access: "public", provenance: true } };
    const bytes = packTarball({ "package/package.json": JSON.stringify(manifest) });
    writeFileSync(archivePath, bytes);
    const registry = fakeRegistry(onlyCandidate);
    await publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "acceptance-placeholder", ...registry });
    expect(registry.calls[0]!.manifest).toEqual(manifest);
    expect(registry.calls[0]!.options.provenance).toBe(false);
    expect(registry.calls[0]!.tarball).toEqual(bytes);
  });

  it.each([
    ["an upstream version beside the candidate", ({ manifest, tarball }: { manifest: { version: string }; tarball: Buffer }) =>
      ({ versions: { [manifest.version]: { dist: { integrity: sri(tarball) } }, "0.0.9": { dist: {} } } }), /expected only the candidate/],
    ["a different tarball for the candidate version", ({ manifest }: { manifest: { version: string } }) =>
      ({ versions: { [manifest.version]: { dist: { integrity: "sha512-other" } } } }), /integrity .* is sha512-other/],
    ["no candidate version", () => ({ versions: {} }), /expected only the candidate/],
  ])("fails when the registry serves %s", async (_label, packument, message) => {
    const { archivePath } = candidate();
    const registry = fakeRegistry(packument as never);
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry })).rejects.toThrow(message);
  });

  it.each(["https://127.0.0.1:4873", "http://registry.npmjs.org", "http://10.0.0.1:4873"])(
    "refuses the non-loopback registry %s before publishing", async (registryValue) => {
      const { archivePath } = candidate();
      const registry = fakeRegistry(onlyCandidate);
      await expect(publishExactLocalRegistry({ archivePath, registry: registryValue, token: "t", ...registry }))
        .rejects.toThrow("loopback HTTP registry");
      expect(registry.calls).toEqual([]);
    });

  it("requires a token", async () => {
    const { archivePath } = candidate();
    const registry = fakeRegistry(onlyCandidate);
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "", ...registry })).rejects.toThrow("usage");
  });

  it("reads the manifest from the packed bytes, not from a host tar", () => {
    expect(readPackedManifest(packTarball({ "package/package.json": '{"name":"x","version":"1.0.0"}' })))
      .toEqual({ name: "x", version: "1.0.0" });
    expect(() => readPackedManifest(packTarball({ "package/index.js": "" }))).toThrow("no package/package.json");
  });
});

describe("pinned npm loader", () => {
  // A fake global npm root; no real npm or its internals are touched.
  function npmRoot(version: string, withLibnpmpublish = true) {
    const root = tempDirectory("dacs-npm-root-");
    mkdirSync(join(root, "npm/node_modules/libnpmpublish"), { recursive: true });
    writeFileSync(join(root, "npm/package.json"), JSON.stringify({ version }));
    if (withLibnpmpublish) {
      writeFileSync(join(root, "npm/node_modules/libnpmpublish/package.json"), JSON.stringify({ main: "index.js" }));
      writeFileSync(join(root, "npm/node_modules/libnpmpublish/index.js"), "exports.publish = async () => 'pinned';\n");
    }
    return root;
  }
  const npmReporting = (version: string, root: string) => (args: string[]) => args[0] === "--version" ? version : root;

  it("loads libnpmpublish only from the pinned npm", async () => {
    const pinned = PINNED_ACCEPTANCE_NPM_VERSION;
    const publish = loadPinnedLibnpmpublish({ npm: npmReporting(pinned, npmRoot(pinned)) });
    await expect(publish()).resolves.toBe("pinned");
  });

  it.each([
    ["a different npm on PATH", () => npmReporting("10.9.8", npmRoot(PINNED_ACCEPTANCE_NPM_VERSION)), /npm --version reports "10.9.8"/],
    ["a different global npm package", () => npmReporting(PINNED_ACCEPTANCE_NPM_VERSION, npmRoot("11.20.0")), /is version "11.20.0"/],
    ["a layout without bundled libnpmpublish", () => npmReporting(PINNED_ACCEPTANCE_NPM_VERSION,
      npmRoot(PINNED_ACCEPTANCE_NPM_VERSION, false)), /libnpmpublish is not bundled/],
    ["no runnable npm", () => () => { throw new Error("spawn npm ENOENT"); }, /npm is not runnable/],
  ])("fails closed with %s", (_label, npm, message) => {
    expect(() => loadPinnedLibnpmpublish({ npm: npm() })).toThrow(message);
    expect(() => loadPinnedLibnpmpublish({ npm: npm() })).toThrow(`requires the pinned npm ${PINNED_ACCEPTANCE_NPM_VERSION}`);
  });

  it("pins the same npm version the acceptance workflow installs", () => {
    const workflow = readFileSync(".github/workflows/registry-container-acceptance.yml", "utf8");
    expect(workflow).toContain(`npm install --global --ignore-scripts npm@${PINNED_ACCEPTANCE_NPM_VERSION}`);
  });
});
