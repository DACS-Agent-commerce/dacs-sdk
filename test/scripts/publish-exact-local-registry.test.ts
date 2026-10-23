import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { Agent, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

// Plain Node ESM script; a computed import keeps it out of the TypeScript program.
const publisherModulePath = "../../scripts/publish-exact-local-registry.mjs";
const { publishExactLocalRegistry, loadPinnedLibnpmpublish, readPackedManifest, PINNED_ACCEPTANCE_NPM_VERSION } =
  await import(publisherModulePath);

const scratch: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});
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
  const requests: RequestInit[] = [];
  return {
    calls, urls, requests,
    publish: async (manifest: { name: string; version: string }, tarball: Buffer, options: Record<string, unknown>) => {
      calls.push({ manifest, tarball, options });
    },
    fetch: async (url: URL, options: RequestInit) => {
      urls.push(String(url));
      requests.push(options);
      return String(url).endsWith("candidate.tgz")
        ? new Response(Uint8Array.from(calls[0]!.tarball))
        : Response.json(packument(calls[0]!));
    },
  };
}
const onlyCandidate = ({ manifest, tarball }: { manifest: { version: string }; tarball: Buffer }) =>
  ({ "dist-tags": { acceptance: manifest.version },
    versions: { [manifest.version]: { dist: { integrity: sri(tarball), tarball: `${REGISTRY}/candidate.tgz` } } } });

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
    expect(call!.options).toEqual({ agent: expect.any(Agent), signal: expect.any(AbortSignal),
      registry: REGISTRY + "/", defaultTag: "acceptance", access: "public", provenance: false, timeout: 15_000, fetchRetries: 0,
      "//127.0.0.1:4873/:_authToken": "acceptance-placeholder" });
    expect(registry.urls).toEqual([`${REGISTRY}/@kynesyslabs%2fdacs`, `${REGISTRY}/candidate.tgz`]);
    expect(registry.requests.every(request => request.redirect === "error" && request.signal instanceof AbortSignal)).toBe(true);
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

  it("rejects a packed tag that would override libnpmpublish's defaultTag", async () => {
    const { archivePath } = candidate();
    writeFileSync(archivePath, packTarball({ "package/package.json": JSON.stringify({
      name: "example", version: "1.0.0", tag: "latest",
    }) }));
    const registry = fakeRegistry(onlyCandidate);
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry }))
      .rejects.toThrow(/packed.*tag/);
    expect(registry.calls).toHaveLength(0);
  });

  it("accepts an explicit packed acceptance tag without changing bytes", async () => {
    const { archivePath } = candidate();
    const bytes = packTarball({ "package/package.json": JSON.stringify({ name: "example", version: "1.0.0", tag: "acceptance" }) });
    writeFileSync(archivePath, bytes);
    const registry = fakeRegistry(onlyCandidate);
    await publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry });
    expect(registry.calls[0]!.tarball).toEqual(bytes);
  });

  it.each([undefined, "0.0.9"])("rejects a missing or wrong acceptance tag (%s)", async acceptance => {
    const { archivePath } = candidate();
    const registry = fakeRegistry(published => ({ ...onlyCandidate(published), "dist-tags": { acceptance } }));
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry }))
      .rejects.toThrow(/acceptance tag/);
  });

  it.each([404, "wrong bytes"])("rejects an advertised tarball serving %s", async served => {
    const { archivePath } = candidate();
    const registry = fakeRegistry(onlyCandidate);
    const fetchArchive = async (url: URL, options: RequestInit) => String(url).endsWith("candidate.tgz")
      ? typeof served === "number" ? new Response(null, { status: served }) : new Response(served)
      : registry.fetch(url, options);
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry, fetch: fetchArchive }))
      .rejects.toThrow(typeof served === "number" ? /HTTP 404/ : /tarball.*match/);
  });

  it.each(["https://example.test/archive.tgz", "http://localhost:4873/archive.tgz", "http://user:password@127.0.0.1:4873/archive.tgz"])(
    "refuses an advertised tarball URL outside the registry trust boundary: %s", async tarball => {
      const { archivePath } = candidate();
      const registry = fakeRegistry(published => {
        const packument = onlyCandidate(published);
        packument.versions[published.manifest.version]!.dist.tarball = tarball;
        return packument;
      });
      await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry }))
        .rejects.toThrow(/tarball URL/);
      expect(registry.urls).toHaveLength(1);
    });

  it.each(["packument", "tarball"])("rejects a redirect from the %s without following it", async target => {
    const { archivePath } = candidate();
    const registry = fakeRegistry(onlyCandidate);
    const fetchRedirect = async (url: URL, options: RequestInit) => {
      if (String(url).endsWith("candidate.tgz") === (target === "tarball")) {
        return new Response(null, { status: 302, headers: { location: "https://example.test/archive.tgz" } });
      }
      return registry.fetch(url, options);
    };
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry, fetch: fetchRedirect }))
      .rejects.toThrow(/HTTP 302/);
  });

  it.each(["EPUBLISHCONFLICT", 409])("verifies a completed publish on retry after %s", async conflict => {
    const { archivePath, bytes, name, version } = candidate();
    const registry = fakeRegistry(onlyCandidate);
    let published = false;
    const publish = async (...args: Parameters<typeof registry.publish>) => {
      if (published) throw Object.assign(new Error("already exists"),
        typeof conflict === "string" ? { code: conflict } : { statusCode: conflict });
      published = true;
      await registry.publish(...args);
    };
    const options = { archivePath, registry: REGISTRY, token: "t", ...registry, publish };
    await expect(publishExactLocalRegistry({ ...options, fetch: async () => { throw new Error("verification disconnected"); } }))
      .rejects.toThrow("verification disconnected");
    await expect(publishExactLocalRegistry(options)).resolves.toEqual({ name, version, integrity: sri(bytes) });
    expect(registry.calls).toHaveLength(1);
  });

  it("rejects different archive bytes after a publish conflict", async () => {
    const { archivePath } = candidate();
    const registry = fakeRegistry(onlyCandidate);
    await registry.publish({ name: "example", version: "0.1.0-test" }, Buffer.from("other"), {});
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry,
      publish: async () => { throw Object.assign(new Error("already exists"), { code: "EPUBLISHCONFLICT" }); },
    })).rejects.toThrow(/integrity/);
  });

  it("preserves unrelated publication failures without verification", async () => {
    const { archivePath } = candidate();
    const registry = fakeRegistry(onlyCandidate);
    const failure = new Error("permission refused");
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry,
      publish: async () => { throw failure; },
    })).rejects.toBe(failure);
    expect(registry.urls).toHaveLength(0);
  });

  it.each(["packument", "tarball"])("bounds streamed %s bytes and cancels an oversized response", async target => {
    const { archivePath } = candidate();
    const registry = fakeRegistry(onlyCandidate);
    const cancel = vi.fn();
    const fetchOversized = async (url: URL, options: RequestInit) => {
      if (String(url).endsWith("candidate.tgz") !== (target === "tarball")) return registry.fetch(url, options);
      let remaining = 18;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (remaining-- > 0) controller.enqueue(new Uint8Array(1024 * 1024));
          else controller.close();
        }, cancel,
      }));
    };
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry, fetch: fetchOversized }))
      .rejects.toThrow(/exceeded.*bytes/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["headers", "packument body", "tarball body"])("times out stalled %s with deterministic timers", async target => {
    vi.useFakeTimers();
    const { archivePath } = candidate();
    const registry = fakeRegistry(onlyCandidate);
    const cancel = vi.fn();
    const fetchStalled = async (url: URL, options: RequestInit) => {
      const isTarball = String(url).endsWith("candidate.tgz");
      if (target === "tarball body" && !isTarball) return registry.fetch(url, options);
      if (target === "headers") return new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
      return new Response(new ReadableStream<Uint8Array>({ cancel }));
    };
    const pending = publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry, fetch: fetchStalled });
    const rejected = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    if (target !== "headers") expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["oversized", "declared", "compressed", "redirect"])("bounds the npm library's %s response before decoding", async kind => {
    const { archivePath } = candidate();
    const registry = fakeRegistry(onlyCandidate);
    const publish = async (_manifest: unknown, _bytes: Buffer, options: { agent: Agent; signal: AbortSignal }) => {
      // Fake TCP transport: exercise Node's HTTP parser and agent without network.
      options.agent.createConnection = () => {
        let sent = false;
        return new Duplex({
          read() {},
          write(_chunk, _encoding, callback) {
            callback();
            if (sent) return;
            sent = true;
            const status = kind === "redirect" ? "302 Found" : "400 Bad Request";
            const headers = kind === "compressed" ? "Content-Encoding: gzip\r\n" : "";
            const framing = kind === "oversized" ? "Connection: close" : `Content-Length: ${2 * 1024 * 1024}`;
            this.push(`HTTP/1.1 ${status}\r\n${headers}${framing}\r\n\r\n`);
            this.push(Buffer.alloc(2 * 1024 * 1024));
            this.push(null);
          },
        });
      };
      await new Promise<void>((resolve, reject) => {
        const req = request(`${REGISTRY}/example`, { agent: options.agent, signal: options.signal }, response => {
          response.on("error", reject);
          response.on("data", () => {});
          response.on("end", resolve);
        });
        req.on("error", reject);
        req.end();
      });
    };
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry, publish }))
      .rejects.toThrow(/exceeded|encoded|redirect/);
    expect(registry.urls).toHaveLength(0);
  });

  it("times out the npm library across its entire publication request", async () => {
    vi.useFakeTimers();
    const { archivePath } = candidate();
    const registry = fakeRegistry(onlyCandidate);
    const publish = async () => new Promise(() => {});
    const rejected = expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry, publish }))
      .rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
  });

  it("rejects an oversized local archive before publishing", async () => {
    const { archivePath } = candidate();
    truncateSync(archivePath, 16 * 1024 * 1024 + 1);
    const registry = fakeRegistry(onlyCandidate);
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry }))
      .rejects.toThrow(/archive exceeded/);
    expect(registry.calls).toHaveLength(0);
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

  it.each(["duplicate", "alias", "nonregular", "size", "checksum", "truncated", "hidden trailer", "extended header", "trailing slash", "directory body"])(
    "rejects a malformed or ambiguous tar manifest: %s", kind => {
      const first = gunzipSync(packTarball({ "package/package.json": '{"name":"first","version":"1.0.0"}' }));
      const second = gunzipSync(packTarball({ "package/package.json": '{"name":"second","version":"1.0.0"}' }));
      let archive = Buffer.from(first);
      const rechecksum = () => {
        archive.fill(32, 148, 156);
        const sum = archive.subarray(0, 512).reduce((total, byte) => total + byte, 0);
        archive.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
      };
      if (kind === "duplicate") archive = Buffer.concat([first.subarray(0, -1024), second]);
      if (kind === "alias") archive = gunzipSync(packTarball({
        "package/package.json": '{"name":"first","version":"1.0.0"}',
        "package/./package.json": '{"name":"second","version":"1.0.0"}',
      }));
      if (kind === "nonregular") { archive.write("2", 156); rechecksum(); }
      if (kind === "trailing slash") { archive.write("/", "package/package.json".length); rechecksum(); }
      if (kind === "directory body") {
        archive.write("5", 156);
        archive.fill(0, 0, 100); archive.write("package/other", 0);
        rechecksum();
        archive = Buffer.concat([archive.subarray(0, -1024), second]);
      }
      if (kind === "size") { archive.write("0000000007x\0", 124); rechecksum(); }
      if (kind === "checksum") archive[0] = 0;
      if (kind === "truncated") archive = first.subarray(0, 600);
      if (kind === "hidden trailer") archive = Buffer.concat([first, second]);
      if (kind === "extended header") {
        archive = Buffer.concat([gunzipSync(packTarball({ "package/path": "" })).subarray(0, 512), first]);
        archive.write("x", 156); rechecksum();
      }
      expect(() => readPackedManifest(gzipSync(archive))).toThrow(/packed tarball/);
    });

  it("bounds decompression before scanning the tar archive", () => {
    const compressed = gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1));
    expect(() => readPackedManifest(compressed)).toThrow(/larger than|exceeded/);
  });

  it("bounds the packed manifest before JSON decoding", () => {
    const bytes = packTarball({ "package/package.json": JSON.stringify({ padding: "x".repeat(1024 * 1024) }) });
    expect(() => readPackedManifest(bytes)).toThrow(/manifest exceeded/);
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

});
