import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { Agent, request, createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

// Plain Node ESM script; a computed import keeps it out of the TypeScript program.
const publisherModulePath = "../../scripts/publish-exact-local-registry.mjs";
const { publishExactLocalRegistry, loadPinnedLibnpmpublish, readPackedArchive, readPackedManifest, PINNED_ACCEPTANCE_NPM_VERSION } =
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
    header.write("000644 \0", 100);
    header.write(body.length.toString(8).padStart(10, "0") + " \0", 124);
    header.write("0000000000 \0", 136);
    header.write("000000 \0".repeat(2), 329); header.write("        ", 148); header.write("0", 156); header.write("ustar\0" + "00", 257);
    let sum = 0; for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + " \0", 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

const sri = (bytes: Buffer) => "sha512-" + createHash("sha512").update(bytes).digest("base64");
const REGISTRY = "http://127.0.0.1:4873";
// Use the running npm's actual HTTP stack, including its error-body handling.
// Future acceptance runs will pin this client to PINNED_ACCEPTANCE_NPM_VERSION.
const npmEntry = realpathSync(process.env.npm_execpath ?? join(
  execFileSync("npm", ["root", "--global"], { encoding: "utf8" }).trim(), "npm/bin/npm-cli.js"));
const npmRequire = createRequire(npmEntry);
const npmPublish = npmRequire("libnpmpublish").publish;
const npmTar = npmRequire("tar");
// Fixed vectors and the public extractor work with every npm tar layout used in CI.
const WINDOWS_PATH_CHARACTERS = new Map([
  ["|", "\uf07c"], ["<", "\uf03c"], [">", "\uf03e"], ["?", "\uf03f"], [":", "\uf03a"],
]);
const windowsPath = (character: string) => WINDOWS_PATH_CHARACTERS.get(character) ?? character;
const numericMetadataFields = [
  { field: "mode", start: 100, length: 8 }, { field: "uid", start: 108, length: 8 },
  { field: "gid", start: 116, length: 8 }, { field: "size", start: 124, length: 12 }, { field: "mtime", start: 136, length: 12 },
  { field: "devmajor", start: 329, length: 8 }, { field: "devminor", start: 337, length: 8 },
];

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
const onlyCandidate = ({ manifest, tarball }: { manifest: { name: string; version: string }; tarball: Buffer }) =>
  ({ name: manifest.name, _id: manifest.name, "dist-tags": { acceptance: manifest.version },
    versions: { [manifest.version]: { ...manifest, dist: { integrity: sri(tarball), shasum: createHash("sha1").update(tarball).digest("hex"), tarball: `${REGISTRY}/candidate.tgz` } } } });

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

  it.each(["redirect", "cross-origin redirect", "compressed conflict", "declared conflict", "oversized conflict",
    "compressed error", "compressed success", "oversized success"])(
    "preserves the npm client's first refusal for a %s without another PUT", async kind => {
      const { archivePath } = candidate();
      const registry = fakeRegistry(onlyCandidate);
      const requests: string[] = [];
      const publish = async (manifest: Parameters<typeof registry.publish>[0], bytes: Buffer, options: { agent: Agent }) => {
        await registry.publish(manifest, bytes, {});
        options.agent.createConnection = () => {
          let sent = false;
          return Object.assign(new Duplex({
            read() {},
            write(chunk, _encoding, callback) {
              callback();
              if (sent) return;
              sent = true;
              requests.push(String(chunk).split("\r\n")[0]!);
              const status = kind.includes("redirect") ? "302 Found" : kind.endsWith("conflict") ? "409 Conflict"
                : kind.endsWith("success") ? "201 Created" : "400 Bad Request";
              const body = kind.startsWith("compressed") ? gzipSync("{}")
                : kind.startsWith("oversized") ? Buffer.alloc(2 * 1024 * 1024) : Buffer.from("{}");
              const headers = kind.includes("redirect") ? `Location: ${kind.startsWith("cross-origin") ? "http://localhost:4873" : REGISTRY}/redirect\r\n`
                : kind.startsWith("compressed") ? "Content-Encoding: gzip\r\n" : "";
              const framing = kind.startsWith("oversized") ? "" :
                `Content-Length: ${kind.startsWith("declared") ? 2 * 1024 * 1024 : body.length}\r\n`;
              this.push(`HTTP/1.1 ${status}\r\n${headers}${framing}Connection: close\r\n\r\n`);
              this.push(body);
              this.push(null);
            },
          }), { setTimeout() { return this; } });
        };
        return npmPublish(manifest, bytes, options);
      };
      await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry, publish }))
        .rejects.toThrow(/redirect|encoded|exceeded/);
      expect(requests).toEqual(["PUT /@kynesyslabs%2fdacs HTTP/1.1"]);
      expect(registry.urls).toHaveLength(0);
    });

  it.each(["root name", "root id", "name", "version", "dependencies", "scripts", "missing field", "extra field", "packed npm field",
    "version id", "extra dist field"])(
    "rejects changed registry manifest metadata (%s), including after a conflict", async field => {
      const { archivePath } = candidate();
      const manifest = { name: "example", version: "1.0.0", dependencies: { example: "1.0.0" },
        scripts: { install: "echo example" }, _npmVersion: "packed-value" };
      const bytes = packTarball({ "package/package.json": JSON.stringify(manifest) });
      writeFileSync(archivePath, bytes);
      const registry = fakeRegistry(published => {
        const packument = onlyCandidate(published);
        const served: Record<string, unknown> = packument.versions[manifest.version]!;
        if (field === "root name") packument.name = "other";
        else if (field === "root id") packument._id = "other";
        else if (field === "missing field") delete served.dependencies;
        else if (field === "extra field") served.optionalDependencies = { other: "2.0.0" };
        else if (field === "version id") served._id = "other@2.0.0";
        else if (field === "extra dist field") served.dist = { ...packument.versions[manifest.version]!.dist, unknown: true };
        else served[field === "packed npm field" ? "_npmVersion" : field] = field === "name" ? "other"
          : field === "version" ? "2.0.0" : { other: "2.0.0" };
        return packument;
      });
      for (const conflict of [false, true]) {
        const publish = async (...args: Parameters<typeof registry.publish>) => {
          if (!conflict) return registry.publish(...args);
          throw Object.assign(new Error("already exists"), { statusCode: 409 });
        };
        await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry, publish }))
          .rejects.toThrow(/metadata/);
      }
    });

  it("accepts only known npm-added version metadata and ignores object key order", async () => {
    const { archivePath } = candidate();
    const registry = fakeRegistry(published => {
      const packument = onlyCandidate(published);
      const served = packument.versions[published.manifest.version]!;
      packument.versions[published.manifest.version] = Object.assign({
        ...Object.fromEntries(Object.entries(served).reverse()), _id: `${published.manifest.name}@${published.manifest.version}`,
        _nodeVersion: process.versions.node, _npmVersion: PINNED_ACCEPTANCE_NPM_VERSION,
      }, served);
      return packument;
    });
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry })).resolves.toBeDefined();
  });

  it.each([false, true])("accepts Verdaccio's empty contributors addition (retry: %s)", async retry => {
    const { archivePath, bytes } = candidate();
    const registry = fakeRegistry(published => {
      const packument = onlyCandidate(published);
      Object.assign(packument.versions[published.manifest.version]!, { contributors: [] });
      return packument;
    });
    if (retry) await registry.publish(readPackedManifest(bytes), bytes, {});
    const publish = retry ? async () => { throw Object.assign(new Error("already published"), { statusCode: 409 }); }
      : registry.publish;
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry, publish }))
      .resolves.toBeDefined();
  });

  it.each([undefined, [], ["different contributor"]])("rejects changing packed contributors to %j", async contributors => {
    const { archivePath } = candidate();
    writeFileSync(archivePath, packTarball({ "package/package.json": JSON.stringify({
      name: "example", version: "1.0.0", contributors: ["packed contributor"],
    }) }));
    const registry = fakeRegistry(published => {
      const packument = onlyCandidate(published);
      Object.assign(packument.versions[published.manifest.version]!, { contributors });
      return packument;
    });
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry }))
      .rejects.toThrow(/metadata/);
  });

  it("verifies the real npm client's published metadata and an ordinary conflict on retry", async () => {
    const { archivePath, bytes, name, version } = candidate();
    let packument: ReturnType<typeof onlyCandidate> | undefined;
    let puts = 0;
    const publish = (manifest: unknown, tarball: Buffer, options: { agent: Agent }) => {
      options.agent.createConnection = () => {
        let written = Buffer.alloc(0);
        let sent = false;
        return Object.assign(new Duplex({
          read() {},
          write(chunk, _encoding, callback) {
            written = Buffer.concat([written, chunk]);
            const end = written.indexOf("\r\n\r\n");
            if (end < 0 || sent) { callback(); return; }
            const length = /content-length: (\d+)/i.exec(written.subarray(0, end).toString());
            if (!length) { callback(new Error("expected npm's Content-Length")); return; }
            callback();
            if (written.length < end + 4 + Number(length[1])) return;
            sent = true;
            packument ??= JSON.parse(written.subarray(end + 4).toString());
            this.push(`HTTP/1.1 ${puts++ === 0 ? "201 Created" : "409 Conflict"}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
            this.push(null);
          },
        }), { setTimeout() { return this; } });
      };
      return npmPublish(manifest, tarball, options);
    };
    const fetch = async (url: URL) => String(url).endsWith(".tgz")
      ? new Response(Uint8Array.from(bytes)) : Response.json(packument);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", publish, fetch }))
        .resolves.toEqual({ name, version, integrity: sri(bytes) });
    }
    expect(puts).toBe(2);
  });

  it("rejects an npm-packed version that npm would normalize before any PUT", async () => {
    const directory = tempDirectory("dacs-npm-pack-");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "example", version: "v1.0.0" }));
    execFileSync(process.execPath, [npmEntry, "pack", "--ignore-scripts", "--offline", "--no-update-notifier", "--json", "--cache", join(directory, "cache")],
      { cwd: directory, stdio: "pipe" });
    const registry = fakeRegistry(onlyCandidate);
    await expect(publishExactLocalRegistry({ archivePath: join(directory, "example-v1.0.0.tgz"),
      registry: REGISTRY, token: "t", ...registry })).rejects.toThrow(/canonical.*name.*version/);
    expect(registry.calls).toHaveLength(0);
  });

  it.each([
    [" Example", "1.0.0"], ["@Scope/example", "1.0.0"], ["example/path", "1.0.0"],
    ["example\n", "1.0.0"], ["example", "1.0.0\n"],
    ["example", "1.0.0+build"], ["example", "=1.0.0"], ["example", " 1.0.0 "],
    ["example", "1.0.0-01"], ["example", "01.0.0"], ["example", "9007199254740992.0.0"],
  ])("rejects noncanonical identity %s@%s before publication", async (name, version) => {
    const { archivePath } = candidate(name, version);
    const registry = fakeRegistry(onlyCandidate);
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry }))
      .rejects.toThrow(/canonical.*name.*version/);
    expect(registry.calls).toHaveLength(0);
  });

  it.each(["1.0.0", "1.0.0-rc.0", "0.1.0-alpha.0"])("accepts the canonical version %s", async version => {
    const { archivePath } = candidate("@kynesyslabs/dacs", version);
    const registry = fakeRegistry(onlyCandidate);
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry }))
      .resolves.toMatchObject({ version });
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

  it.each(["alternate/package.json", "alternate/index.js", "package"])(
    "rejects a stripping alias outside package/ before publication: %s", async alias => {
      const { archivePath } = candidate();
      writeFileSync(archivePath, packTarball({
        "package/package.json": '{"name":"example","version":"1.0.0"}',
        [alias]: '{"name":"other","version":"9.9.9"}',
      }));
      const registry = fakeRegistry(onlyCandidate);
      await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry }))
        .rejects.toThrow(/packed tarball.*path/);
      expect(registry.calls).toHaveLength(0);
    });

  it("refuses a package/ root directory entry", () => {
    const archive = gunzipSync(packTarball({ "package/": "", "package/package.json": '{"name":"example","version":"1.0.0"}' }));
    archive.write("5", 156);
    archive.fill(32, 148, 156);
    const checksum = archive.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
    archive.write(checksum.toString(8).padStart(6, "0") + " \0", 148);
    expect(() => readPackedManifest(gzipSync(archive))).toThrow(/packed tarball/);
  });

  it.each(["duplicate", "alias", "nonregular", "size", "checksum", "truncated", "hidden trailer", "extended header", "trailing slash", "directory body"])(
    "rejects a malformed or ambiguous tar manifest: %s", kind => {
      const first = gunzipSync(packTarball({ "package/package.json": '{"name":"first","version":"1.0.0"}' }));
      const second = gunzipSync(packTarball({ "package/package.json": '{"name":"second","version":"1.0.0"}' }));
      let archive = Buffer.from(first);
      const rechecksum = () => {
        archive.fill(32, 148, 156);
        const sum = archive.subarray(0, 512).reduce((total, byte) => total + byte, 0);
        archive.write(sum.toString(8).padStart(6, "0") + " \0", 148);
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

  it.each(["regular", "directory", "NUL-prefixed"])("rejects a nonzero tar linkname on a %s entry before publishing", async kind => {
    const { archivePath } = candidate();
    const hidden = gunzipSync(packTarball({ "package/package.json": '{"name":"hidden","version":"9.9.9"}' }));
    const archive = gunzipSync(packTarball({
      "package/payload": kind === "directory" ? "" : hidden.toString("utf8"),
      "package/package.json": '{"name":"example","version":"1.0.0"}',
    }));
    if (kind === "directory") archive.write("5", 156);
    archive.write("hidden", kind === "NUL-prefixed" ? 251 : 157);
    archive.fill(32, 148, 156);
    const checksum = archive.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
    archive.write(checksum.toString(8).padStart(6, "0") + " \0", 148);
    writeFileSync(archivePath, gzipSync(archive));
    const registry = fakeRegistry(onlyCandidate);
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry }))
      .rejects.toThrow(/packed tarball/);
    expect(registry.calls).toHaveLength(0);
  });

  it.each(["checksum", "name"])("rejects a smuggled manifest behind an ambiguous %s header before publishing", async kind => {
    const { archivePath } = candidate();
    const hidden = gunzipSync(packTarball({ "package/package.json": '{"name":"hidden","version":"9.9.9"}' }));
    const archive = gunzipSync(packTarball({
      "package/package.json": '{"name":"example","version":"1.0.0"}',
      "package/payload": hidden.toString("utf8"),
    }));
    const header = archive.subarray(1024, 1536);
    if (kind === "name") header.write("package/x\0\n" + "a".repeat(88) + "/", 0, 100);
    header.fill(32, 148, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(kind === "checksum" ? checksum.toString(8).padStart(8, "0")
      : checksum.toString(8).padStart(6, "0") + " \0", 148);
    writeFileSync(archivePath, gzipSync(archive));
    const registry = fakeRegistry(onlyCandidate);
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry }))
      .rejects.toThrow(/packed tarball/);
    expect(registry.calls).toHaveLength(0);
  });

  it.each(numericMetadataFields.flatMap(field => [0x81, 0x80, 0xff, 0x39].map(byte => ({ ...field, byte }))))(
    "rejects a smuggled manifest behind an invalid numeric $field header ($byte) before publishing", async ({ start, byte }) => {
      const { archivePath } = candidate();
      const hidden = gunzipSync(packTarball({ "package/package.json": '{"name":"hidden","version":"9.9.9"}' }));
      const archive = gunzipSync(packTarball({
        "package/package.json": '{"name":"example","version":"1.0.0"}',
        "package/payload": hidden.toString("utf8"),
      }));
      const header = archive.subarray(1024, 1536);
      header[start] = byte;
      header.fill(32, 148, 156);
      const checksum = header.reduce((sum, value) => sum + value, 0);
      header.write(checksum.toString(8).padStart(6, "0") + " \0", 148);
      writeFileSync(archivePath, gzipSync(archive));
      const registry = fakeRegistry(onlyCandidate);
      await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry }))
        .rejects.toThrow(/packed tarball/);
      expect(registry.calls).toHaveLength(0);
    });

  it.each([0, 345].flatMap(start => ["\n", "\r", "\u2028", "\u2029", "hidden"].map(suffix => ({ start, suffix }))))(
    "rejects nonzero padding after a NUL in tar path field $start ($suffix)", ({ start, suffix }) => {
      const archive = gunzipSync(packTarball({ "package/package.json": '{"name":"example","version":"1.0.0"}' }));
      const name = start === 0 ? "package/package.json" : "";
      archive.write(name + "\0" + suffix, start);
      archive.fill(32, 148, 156);
      const checksum = archive.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
      archive.write(checksum.toString(8).padStart(6, "0") + " \0", 148);
      expect(() => readPackedManifest(gzipSync(archive))).toThrow(/packed tarball/);
    });

  it("rejects a prefix alias with nonstandard ustar version bytes", () => {
    const first = gunzipSync(packTarball({ "package/package.json": '{"name":"first","version":"1.0.0"}' }));
    const second = gunzipSync(packTarball({ "package/package.json": '{"name":"other","version":"9.9.9"}' }));
    second.write("XX", 263);
    second.write("package/hidden", 345);
    second.fill(32, 148, 156);
    const sum = second.subarray(0, 512).reduce((total, byte) => total + byte, 0);
    second.write(sum.toString(8).padStart(6, "0") + " \0", 148);
    expect(() => readPackedManifest(gzipSync(Buffer.concat([first.subarray(0, -1024), second]))))
      .toThrow(/packed tarball/);
  });

  it.each([
    "package/c:package.json", "package/C:package.json", "package/PACKAGE.JSON",
    "package/package.json.", "package/package.json ", "package/sub./hidden.js",
    "package/sub /hidden.js", "package/sub/c:payload.js", "package/index.js:payload",
  ])("rejects extraction aliases before publishing: %s", async alias => {
    const { archivePath } = candidate();
    writeFileSync(archivePath, packTarball({
      "package/package.json": '{"name":"example","version":"1.0.0"}',
      [alias]: '{"name":"hidden","version":"9.9.9"}',
    }));
    const registry = fakeRegistry(onlyCandidate);
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry }))
      .rejects.toThrow(/packed tarball/);
    expect(registry.calls).toHaveLength(0);
  });

  const unicodeAliases = [
    ["café.js", "cafe\u0301.js"], ["package.json", "package.jſon"], ["σ.js", "ς.js"],
    ["straße.js", "STRASSE.js"], ["ẞ.js", "ss.js"], ["ﬁ.js", "fi.js"], ["a≯.js", "a>\u0338.js"], ["a≮.js", "a<\u0338.js"],
  ];
  it.each(unicodeAliases)("rejects Unicode extraction aliases %s / %s before publishing", async (declared, alias) => {
    const { archivePath } = candidate();
    writeFileSync(archivePath, packTarball({
      "package/package.json": JSON.stringify({ name: "example", version: "1.0.0", main: declared }),
      ...(declared === "package.json" ? {} : { ["package/" + declared]: "expected" }),
      ["package/" + alias]: "other",
    }));
    const registry = fakeRegistry(onlyCandidate);
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry }))
      .rejects.toThrow(/packed tarball/);
    expect(registry.calls).toHaveLength(0);
  });

  it("refuses distinct Unicode paths and a Windows-translated name", () => {
    const manifest = { name: "example", version: "1.0.0", main: "café?.js" };
    expect(() => readPackedManifest(packTarball({
      "package/package.json": JSON.stringify(manifest),
      "package/café?.js": "main", "package/σ.js": "other",
    }))).toThrow(/packed tarball/);
  });

  it.each(["|", "<", ">", "?", ":"])("rejects npm Windows extraction aliases for %s", async character => {
    const declared = "index" + windowsPath(character) + ".js";
    const alias = "index" + character + ".js";
    const bytes = packTarball({
      "package/package.json": JSON.stringify({ name: "example", version: "1.0.0", main: declared }),
      ["package/" + declared]: "expected",
      ["package/" + alias]: "other",
    });
    // Exercise the installed npm extractor's Windows mode on every platform.
    const extraction = tempDirectory("dacs-win32-extraction-");
    npmTar.x({ cwd: extraction, strip: 1, sync: true, win32: true }).end(bytes);
    expect(readFileSync(join(extraction, declared), "utf8")).toBe("other");
    const { archivePath } = candidate();
    writeFileSync(archivePath, bytes);
    const registry = fakeRegistry(onlyCandidate);
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry }))
      .rejects.toThrow(/packed tarball/);
    expect(registry.calls).toHaveLength(0);
  });

  it.each(["duplicate payload", "file then directory", "directory then file", "file then child", "child then file"]
    .flatMap(kind => [
      ["index.js", "index.js"], ["index.js", "INDEX.JS"],
    ].map(([fileName, conflictName]) => ({ kind, fileName, conflictName }))))(
    "rejects ambiguous archive paths: $kind ($fileName / $conflictName)", ({ kind, fileName, conflictName }) => {
      const manifest = gunzipSync(packTarball({ "package/package.json": '{"name":"example","version":"1.0.0"}' }));
      const entry = (name: string, body: string, directory = false) => {
        const tar = gunzipSync(packTarball({ [name]: body }));
        if (directory) {
          tar.write("5", 156); tar.fill(32, 148, 156);
          const sum = tar.subarray(0, 512).reduce((total, byte) => total + byte, 0);
          tar.write(sum.toString(8).padStart(6, "0") + " \0", 148);
        }
        return tar.subarray(0, -1024);
      };
      const file = entry("package/payload-" + fileName, "module.exports = 1;");
      const conflictPath = "package/payload-" + conflictName;
      const paths = kind === "duplicate payload" ? [file, entry(conflictPath, "module.exports = 2;")]
        : kind === "file then directory" ? [file, entry(conflictPath + "/", "", true)]
        : kind === "directory then file" ? [entry(conflictPath + "/", "", true), file]
        : kind === "file then child" ? [file, entry(conflictPath + "/child.js", "code")]
        : [entry(conflictPath + "/child.js", "code"), file];
      expect(() => readPackedManifest(gzipSync(Buffer.concat([
        manifest.subarray(0, -1024), ...paths, Buffer.alloc(1024),
      ])))).toThrow(/packed tarball/);
    });

  it.each([false, true])("rejects a wrong registry SHA-1 (conflict recovery: %s)", async conflict => {
    const { archivePath } = candidate();
    const registry = fakeRegistry(published => {
      const packument = onlyCandidate(published);
      packument.versions[published.manifest.version]!.dist.shasum = "0".repeat(40);
      return packument;
    });
    const publish = async (...args: Parameters<typeof registry.publish>) => {
      await registry.publish(...args);
      if (conflict) throw Object.assign(new Error("already exists"), { statusCode: 409 });
    };
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry, publish }))
      .rejects.toThrow(/shasum/);
  });

  it("bounds decompression before scanning the tar archive", () => {
    const compressed = gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1));
    expect(() => readPackedManifest(compressed)).toThrow(/byte limit/);
  });

  it("bounds the packed manifest before JSON decoding", () => {
    const bytes = packTarball({ "package/package.json": JSON.stringify({ padding: "x".repeat(1024 * 1024) }) });
    expect(() => readPackedManifest(bytes)).toThrow(/manifest exceeded/);
  });

});


function repairChecksum(header: Buffer) {
  header.fill(32, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, "0") + " \0", 148);
}
const sizeLeads = ["c2a0", "e28083", "e280a8", "e280a9", "efbbbf", "e38080"];
function hiddenArchive() {
  const hidden = gunzipSync(packTarball({
    "package/package.json": '{"name":"hidden","version":"9.9.9"}', "package/evil.js": "hidden",
  }));
  return gunzipSync(packTarball({
    "package/package.json": '{"name":"example","version":"1.0.0"}',
    "package/payload.bin": hidden.toString("utf8"),
  }));
}
describe("canonical packed archive", () => {
  const numericFields = [...numericMetadataFields, { field: "checksum", start: 148, length: 8 }];
  it.each(numericMetadataFields.flatMap(field => ["space+NUL", "NUL", "empty"].map(encoding => ({ ...field, encoding }))))(
    "accepts node-tar $field zero/empty encoding $encoding", ({ start, length, encoding }) => {
      const manifest = { name: "example", version: "1.0.0" };
      const archive = gunzipSync(packTarball({ "package/empty": "", "package/package.json": JSON.stringify(manifest) }));
      archive.fill(0, start, start + length);
      if (encoding !== "empty") archive.write("0".repeat(length - (encoding === "NUL" ? 1 : 2)) + (encoding === "NUL" ? "\0" : " \0"), start);
      repairChecksum(archive.subarray(0, 512));
      const result = readPackedArchive(gzipSync(archive));
      expect(result.manifest).toEqual(manifest);
      expect(result.files.get("package/empty")).toEqual(Buffer.alloc(0));
    });
  it("accepts the exact seven-digit mode 0000644 followed by NUL", () => {
    const archive = gunzipSync(packTarball({ "package/package.json": '{"name":"example","version":"1.0.0"}' }));
    archive.write("0000644\0", 100); repairChecksum(archive.subarray(0, 512));
    expect(readPackedManifest(gzipSync(archive))).toEqual({ name: "example", version: "1.0.0" });
  });
  it.each(numericFields.flatMap(field => ["space+NUL", "NUL"].map(encoding => ({ ...field, encoding }))))(
    "accepts node-tar $field nonzero encoding $encoding", ({ field, start, length, encoding }) => {
      const manifest = { name: "example", version: "1.0.0" }, text = JSON.stringify(manifest);
      const archive = gunzipSync(packTarball({ "package/package.json": text }));
      const value = field === "size" ? Buffer.byteLength(text) : field === "checksum" ? Number.parseInt(archive.toString("latin1", 148, 156), 8) : 0o777777;
      archive.write(value.toString(8).padStart(length - (encoding === "NUL" ? 1 : 2), "0") + (encoding === "NUL" ? "\0" : " \0"), start);
      if (field !== "checksum") repairChecksum(archive.subarray(0, 512));
      expect(readPackedManifest(gzipSync(archive))).toEqual(manifest);
    });
  it.each(numericFields.flatMap(field => ["non-octal", "base-256", "overlong", "leading space", "embedded NUL", "newline"].map(encoding => ({ ...field, encoding }))))(
    "refuses malformed $field encoding $encoding", ({ field, start, length, encoding }) => {
      const archive = hiddenArchive();
      const header = archive.subarray(1024, 1536);
      const value = encoding === "non-octal" ? "9" + "0".repeat(length - 2) + "\0"
        : encoding === "base-256" ? "\x80" + "\0".repeat(length - 1)
        : encoding === "overlong" ? "0".repeat(length)
        : encoding === "leading space" ? " " + "0".repeat(length - 2) + "\0"
        : encoding === "embedded NUL" ? "0\0" + "0".repeat(length - 3) + "\0"
        : "0".repeat(length - 2) + "\n\0";
      header.write(value, start, length, "latin1");
      if (field !== "checksum") repairChecksum(header);
      expect(() => readPackedManifest(gzipSync(archive))).toThrow(/packed tarball/);
    });
  it.each(["\0".repeat(8), "0000000\0", "000000 \0"])("refuses an empty or zero checksum %j", value => {
    const archive = hiddenArchive(); archive.write(value, 1024 + 148);
    expect(() => readPackedManifest(gzipSync(archive))).toThrow(/checksum/);
  });
  it.each(sizeLeads)("refuses a hidden manifest behind size lead %s before publication", async lead => {
    const archive = hiddenArchive();
    const header = archive.subarray(1024, 1536);
    const prefix = Buffer.from(lead, "hex");
    const size = Number.parseInt(header.subarray(124, 136).toString(), 8);
    header.fill(0, 124, 136); prefix.copy(header, 124);
    header.write(size.toString(8).padStart(11 - prefix.length, "0"), 124 + prefix.length);
    repairChecksum(header);
    const { archivePath } = candidate(); writeFileSync(archivePath, gzipSync(archive));
    const registry = fakeRegistry(onlyCandidate);
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry }))
      .rejects.toThrow(/packed tarball/);
    expect(registry.calls).toHaveLength(0);
  });
  it.each([100,108,116,124,136,148,156,157,257,263,265,297,329,337,345,500])(
    "refuses a noncanonical field at byte %s", offset => {
      const archive = hiddenArchive(); const header = archive.subarray(1024,1536);
      header[offset] = 0x7f;
      if (offset !== 148) repairChecksum(header);
      expect(() => readPackedManifest(gzipSync(archive))).toThrow(/packed tarball/);
    });
  it.each(["package/a\\b.js", "package/sub\\file.js", "package/con", "package/LPT9.js", "package/aux/x.js",
    "package/a[1].js", "package/trailing."])("refuses unsupported path %s before publication", async path => {
    const { archivePath } = candidate();
    writeFileSync(archivePath, packTarball({ "package/package.json": '{"name":"example","version":"1.0.0"}', [path]: "x" }));
    const registry = fakeRegistry(onlyCandidate);
    await expect(publishExactLocalRegistry({ archivePath, registry: REGISTRY, token: "t", ...registry })).rejects.toThrow();
    expect(registry.calls).toHaveLength(0);
  });
  it.each(["http://u:p@127.0.0.1:4873/prefix/", "http://127.0.0.1:4873/prefix?x=1", "http://127.0.0.1:4873/prefix#x",
    "http://127.0.0.1:4873/prefix?", "http://127.0.0.1:4873/prefix#"])(
    "refuses ambiguous registry URL %s before publication", async registry => {
      const fixture = fakeRegistry(onlyCandidate);
      await expect(publishExactLocalRegistry({ ...candidate(), ...fixture, registry, token: "t" })).rejects.toThrow(/loopback/);
      expect(fixture.calls).toHaveLength(0);
    });
  it.each(["/prefix", "/prefix/", "/prefix%3F", "/prefix%23"])("preserves valid registry path prefix %s", async prefix => {
    const registry = fakeRegistry(onlyCandidate);
    await expect(publishExactLocalRegistry({ ...candidate("example", "1.0.0"), ...registry,
      registry: REGISTRY + prefix, token: "t" })).resolves.toMatchObject({ name: "example", version: "1.0.0" });
    expect(registry.urls[0]).toBe(REGISTRY + prefix.replace(/\/$/, "") + "/example");
  });
  it.each(["padding", "extra trailer", "invalid utf8", "BOM", "array", "empty gzip", "non-gzip"])("refuses %s", kind => {
    const archive = gunzipSync(packTarball({ "package/package.json": kind === "array" ? "[]" : kind === "BOM" ? '\ufeff{"name":"x"}' : '{"name":"x"}' }));
    if (kind === "padding") archive[1023] = 1;
    if (kind === "invalid utf8") archive[512 + 9] = 255;
    const bytes = kind === "non-gzip" ? Buffer.from("bad") : gzipSync(kind === "extra trailer" ? Buffer.concat([archive,Buffer.alloc(512)])
      : kind === "empty gzip" ? Buffer.alloc(0) : archive);
    expect(() => readPackedManifest(bytes)).toThrow(/packed/);
  });
  it("preserves decompression and npm-loader failure causes", () => {
    const cause = new Error("fixture npm failure");
    try { loadPinnedLibnpmpublish({ npm: () => { throw cause; } }); throw Error("expected failure"); }
    catch (error) { expect(error).toMatchObject({ cause }); }
    try { readPackedManifest(Buffer.from("bad")); throw Error("expected failure"); }
    catch (error) { expect(error).toMatchObject({ message: expect.stringContaining("packed tarball"), cause: expect.any(Error) }); }
  });
  it.each(["packument", "tarball URL"])("preserves invalid %s context and cause", async kind => {
    const registry = fakeRegistry(published => {
      const packument = onlyCandidate(published);
      packument.versions[published.manifest.version]!.dist.tarball = "invalid URL";
      return packument;
    });
    const fetch = kind === "packument" ? async () => new Response("{") : registry.fetch;
    await expect(publishExactLocalRegistry({ ...candidate(), ...registry, registry: REGISTRY, token:"t", fetch }))
      .rejects.toMatchObject({ message: expect.stringContaining(kind === "packument" ? "packument JSON" : "tarball URL"), cause: expect.any(Error) });
  });
  it("matches a real npm-pack header and accepts its complete file map", () => {
    const directory = tempDirectory("canonical-npm-pack-");
    const text = JSON.stringify({ name: "example", version: "1.0.0" });
    writeFileSync(join(directory,"package.json"),text,{ mode: 0o644 });
    chmodSync(join(directory,"package.json"),0o644);
    execFileSync(process.execPath,[npmEntry,"pack","--ignore-scripts","--json"],{cwd:directory,stdio:"pipe",timeout:30_000});
    const bytes = readFileSync(join(directory,"example-1.0.0.tgz"));
    const result = readPackedArchive(bytes);
    expect(result.manifest).toEqual(JSON.parse(text));
    expect(result.files).toEqual(new Map([["package/package.json",Buffer.from(text)]]));
  },45_000);
  it.runIf(npmRequire("../package.json").version === PINNED_ACCEPTANCE_NPM_VERSION)(
    `reads a real package packed with pinned npm ${PINNED_ACCEPTANCE_NPM_VERSION}`, () => {
      const directory = tempDirectory("pinned-npm-pack-");
      const manifest = { name: "example", version: "1.0.0" };
      writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
      execFileSync(process.execPath, [npmEntry, "pack", "--ignore-scripts", "--json"], { cwd: directory, stdio: "pipe", timeout: 30_000 });
      expect(readPackedManifest(readFileSync(join(directory, "example-1.0.0.tgz")))).toEqual(manifest);
    }, 45_000);
  it("publishes through a symlink CLI and safely imports with a missing argv file", async () => {
    const { archivePath, bytes, name, version } = candidate();
    const directory = tempDirectory("publisher-cli-");
    const root = join(directory,"modules"), module = join(root,"npm","node_modules","libnpmpublish");
    mkdirSync(module,{ recursive:true });
    writeFileSync(join(root,"npm","package.json"),JSON.stringify({ version: PINNED_ACCEPTANCE_NPM_VERSION }));
    writeFileSync(join(module,"package.json"),'{"main":"index.cjs"}');
    writeFileSync(join(module,"index.cjs"),"module.exports = require(" + JSON.stringify(npmRequire.resolve("libnpmpublish")) + ");");
    const npm = join(directory,"npm");
    writeFileSync(npm,`#!${process.execPath}\nconsole.log(process.argv[2] === '--version' ? ${JSON.stringify(PINNED_ACCEPTANCE_NPM_VERSION)} : ${JSON.stringify(root)});`);
    chmodSync(npm,0o755);
    const cli = join(directory,"publisher.mjs");
    const source = realpathSync("scripts/publish-exact-local-registry.mjs");
    symlinkSync(source,cli);
    let puts = 0; let packument: unknown;
    const server = createServer((request,response) => {
      if (request.method === "PUT") {
        const chunks: Buffer[] = []; request.on("data",chunk => chunks.push(chunk));
        request.on("end",() => { packument = JSON.parse(Buffer.concat(chunks).toString()); puts++; response.writeHead(201); response.end("{}"); });
      } else if (request.url?.endsWith(".tgz")) { response.end(bytes); }
      else { response.setHeader("content-type","application/json"); response.end(JSON.stringify(packument)); }
    });
    await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw Error("missing port");
      const registry = `http://127.0.0.1:${address.port}`;
      const result = await new Promise<{code:number|null; output:string}>((resolve,reject) => {
        const child = spawn(process.execPath,[cli,archivePath,registry],{ env: { ...process.env,
          PATH: directory + ":" + process.env.PATH, DACS_LOCAL_REGISTRY_TOKEN:"fixture" }, timeout:20_000 });
        let output = ""; child.stdout.on("data",chunk => { output += chunk; }); child.stderr.on("data",chunk => { output += chunk; });
        child.on("error",reject); child.on("close",code => resolve({code,output}));
      });
      expect(result.output).not.toContain("Error:"); expect(result.code).toBe(0); expect(puts).toBe(1);
      expect(packument).toMatchObject({ name, versions: { [version]: { name, version } } });
      execFileSync(process.execPath,["--input-type=module","-e",`process.argv[1] = '/missing-argv-file'; await import(${JSON.stringify(source)});`],{stdio:"pipe",timeout:10_000});
    } finally { await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); }
  },30_000);
  it("refuses header mutations or agrees with npm's complete warning-free extraction", () => {
    expect(typeof readPackedArchive).toBe("function");
    const original = hiddenArchive();
    const values = [...new Set([0,1,2,8,9,10,11,12,13,31,32,46,47,48,55,56,57,58,64,65,90,95,97,122,126,127,128,129,194,226,239,255])].map(byte => Buffer.from([byte]));
    values.push(...sizeLeads.map(lead => Buffer.from(lead,"hex")));
    const directory = tempDirectory("canonical-sweep-");
    let variants = 0;
    for (let offset = 0; offset < 512; offset++) for (const value of values) {
      if (offset + value.length > 512) continue;
      const archive = Buffer.from(original); const header = archive.subarray(1024,1536);
      value.copy(header,offset); repairChecksum(header);
      const bytes = gzipSync(archive); variants++;
      let parsed;
      try { parsed = readPackedArchive(bytes); } catch { continue; }
      const cwd = join(directory,"extract"); mkdirSync(cwd);
      const warnings: string[] = [];
      try {
        npmTar.x({ cwd, sync: true, onwarn: (code: string, message: string) => warnings.push(code + message) }).end(bytes);
        const files = new Map<string,Buffer>();
        const visit = (relative: string) => {
          for (const entry of readdirSync(join(cwd,relative),{withFileTypes:true})) {
            const name = relative ? relative + "/" + entry.name : entry.name;
            if (entry.isDirectory()) visit(name);
            else { expect(entry.isFile()).toBe(true); chmodSync(join(cwd,name),0o600); files.set(name,readFileSync(join(cwd,name))); }
          }
        }; visit("");
        expect(warnings,`offset ${offset}, ${value.toString("hex")}`).toEqual([]);
        expect(files).toEqual(parsed.files);
        expect(JSON.parse(files.get("package/package.json")!.toString())).toEqual(parsed.manifest);
      } finally { rmSync(cwd,{recursive:true,force:true}); }
    }
    expect(variants).toBeGreaterThan(19_000);
  },180_000);
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
    expect(workflow).toContain("run_bounded node scripts/acceptance-bootstrap.mjs");
    const bootstrap = readFileSync("scripts/acceptance-bootstrap.mjs", "utf8");
    expect(bootstrap).toContain(`version: "${PINNED_ACCEPTANCE_NPM_VERSION}"`);
  });
});
