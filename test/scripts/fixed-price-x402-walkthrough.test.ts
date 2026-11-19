import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const authenticated = vi.hoisted(() => ({ value: true }));
vi.mock("@kynesyslabs/dacs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isAuthenticatedRailDefinition: () => authenticated.value,
  getAuthenticatedRailProvenance: () => authenticated.value ? { registryVersion: 1 } : null,
}));

import { rawPublicKey } from "../../src/crypto/ed25519.js";
import { signedBytes } from "../../src/crypto/signing.js";
import { demosAgentClaimRef } from "../../src/identity/demos.js";
import { identityBundleHash } from "../../src/identity/bundle.js";

const root = resolve(import.meta.dirname, "../..");
const scriptPath = join(root, "scripts/fixed-price-x402-walkthrough.mjs");
const nodePath = join(root, "packages/dacs-node/dist/listingDoctor.js");
const walkthrough = await import(scriptPath);
const { inspectDacsX402ListingDraftV1 } = await import(nodePath);

const SELLER_URL = "https://seller.example/walkthrough";
const PAYEE = `0x${"2".repeat(40)}`;
const directories: string[] = [];

function freshDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "walkthrough-test-"));
  directories.push(directory);
  return directory;
}

function reply(body: unknown, init?: ResponseInit): typeof fetch {
  return (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), init)) as typeof fetch;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("argument parsing", () => {
  const init = ["init", "--run-dir", "/run", "--seller-url", SELLER_URL, "--evm-rpc", "https://rpc.example/key"];
  it("accepts init with its three options", () => {
    expect(walkthrough.parseArguments(init)).toMatchObject({
      command: "init", runDir: "/run", sellerUrl: SELLER_URL, evmRpc: "https://rpc.example/key",
    });
  });
  it("refuses an unknown command", () => {
    expect(() => walkthrough.parseArguments(["setup", "--run-dir", "/run"])).toThrow(/unknown command/);
  });
  it.each([
    [["init", "--run-dir", "/a", "--run-dir", "/b"], /repeated/],
    [["registry", "--run-dir", "/a", "--listing-ref", "x"], /unknown option/],
    [["registry", "--run-dir"], /needs a value/],
    [["init", "--run-dir", "/a", "--seller-url", SELLER_URL], /--evm-rpc is required/],
    [["init", "--run-dir", "/a", "--confirm"], /unknown option/],
  ])("refuses bad options: %j", (argv, message) => {
    expect(() => walkthrough.parseArguments(argv)).toThrow(message);
  });
  it("accepts --confirm for registry", () => {
    expect(walkthrough.parseArguments(["registry", "--run-dir", "/a", "--confirm"]).confirm).toBe(true);
  });
  it("refuses an EVM RPC that is not HTTPS", () => {
    expect(() => walkthrough.parseArguments(init.map((part) => part.startsWith("https://rpc") ? "http://rpc.example" : part)))
      .toThrow(/HTTPS/);
  });
});

describe("run directory", () => {
  it("refuses a run directory inside the checkout, also through a symbolic link", () => {
    const base = freshDirectory();
    const checkout = join(base, "checkout");
    mkdirSync(join(checkout, "run"), { recursive: true, mode: 0o700 });
    symlinkSync(join(checkout, "run"), join(base, "link"));
    expect(() => walkthrough.checkRunDirectory(join(checkout, "run"), checkout)).toThrow(/inside the checkout/);
    expect(() => walkthrough.checkRunDirectory(join(base, "link"), checkout)).toThrow(/inside the checkout/);
  });
  it("refuses a run directory that is not mode 0700", () => {
    const base = freshDirectory();
    mkdirSync(join(base, "checkout"));
    mkdirSync(join(base, "run"), { mode: 0o700 });
    chmodSync(join(base, "run"), 0o750);
    expect(() => walkthrough.checkRunDirectory(join(base, "run"), join(base, "checkout"))).toThrow(/0700/);
  });
  it("accepts an owner-only run directory outside the checkout", () => {
    const base = freshDirectory();
    mkdirSync(join(base, "checkout"));
    mkdirSync(join(base, "run"), { mode: 0o700 });
    expect(walkthrough.checkRunDirectory(join(base, "run"), join(base, "checkout"))).toBe(realpathSync(join(base, "run")));
  });
  it("refuses init when secrets exists", () => {
    const run = freshDirectory();
    mkdirSync(join(run, "secrets"));
    expect(() => walkthrough.checkFreshInit(run)).toThrow(/secrets/);
  });
  it("refuses init when state.json records init", () => {
    const run = freshDirectory();
    walkthrough.writeState(run, { init: { commit: "c" } });
    expect(() => walkthrough.checkFreshInit(run)).toThrow(/already ran/);
  });
  it("allows init on a fresh run directory", () => {
    expect(() => walkthrough.checkFreshInit(freshDirectory())).not.toThrow();
  });
});

describe("state file", () => {
  it("writes atomically with mode 0600 and leaves no temporary file", () => {
    const run = freshDirectory();
    const previousUmask = process.umask(0);
    try {
      walkthrough.writeState(run, { init: { commit: "c" } });
      walkthrough.writeState(run, { init: { commit: "c" }, registry: { draft: "written" } });
    } finally {
      process.umask(previousUmask);
    }
    expect(readdirSync(run)).toEqual(["state.json"]);
    expect(statSync(join(run, "state.json")).mode & 0o777).toBe(0o600);
    expect(walkthrough.readState(run).registry).toEqual({ draft: "written" });
  });
});

describe("chain id", () => {
  const rpc = (result: unknown) => reply({ jsonrpc: "2.0", id: 1, result });
  it("accepts Base Sepolia", async () => {
    await expect(walkthrough.assertBaseSepolia("https://rpc.example/", rpc("0x14a34"))).resolves.toBeUndefined();
  });
  it("refuses another chain id", async () => {
    await expect(walkthrough.assertBaseSepolia("https://rpc.example/", rpc("0x1"))).rejects.toThrow(/84532/);
  });
  it("refuses a reply that is not a JSON-RPC result", async () => {
    await expect(walkthrough.assertBaseSepolia("https://rpc.example/", reply({ error: {} }))).rejects.toThrow(/reply/);
  });
  it("refuses a reply over the byte limit before decoding it", async () => {
    await expect(walkthrough.assertBaseSepolia("https://rpc.example/", reply("x".repeat(70_000)))).rejects.toThrow(/too large/);
  });
  it("reads the block number as a safe integer", async () => {
    await expect(walkthrough.readRpcNumber("https://rpc.example/", "eth_blockNumber", rpc("0x10"))).resolves.toBe(16);
    await expect(walkthrough.readRpcNumber("https://rpc.example/", "eth_blockNumber", rpc("16"))).rejects.toThrow(/reply/);
  });
});

describe("seller URL and authority", () => {
  it("normalizes once and returns the exact string every later use needs", () => {
    expect(walkthrough.normalizeSellerUrl("https://Seller.Example/walkthrough")).toBe(SELLER_URL);
  });
  it.each(["http://seller.example/a", "https://u:p@seller.example/a", "https://seller.example/a?q=1", "https://seller.example/a#x", "seller.example"])(
    "refuses a seller URL that is not plain HTTPS: %s", (value) => {
      expect(() => walkthrough.normalizeSellerUrl(value)).toThrow();
    });
  it.each(["https://seller.example", "https://seller.example/"])("refuses a root path, which the seller cannot serve: %s", (value) => {
    expect(() => walkthrough.normalizeSellerUrl(value)).toThrow(/needs a path/);
  });
  it("normalizes uppercase and 0x-prefixed keys to a lowercase authority", () => {
    const hex = "ab".repeat(32);
    const expected = `did:demos:agent:${hex}`;
    expect(walkthrough.normalizeAuthority(`0x${hex.toUpperCase()}`)).toBe(expected);
    expect(walkthrough.normalizeAuthority(hex)).toBe(expected);
  });
  it("refuses a key of the wrong length", () => {
    expect(() => walkthrough.normalizeAuthority("0x" + "ab".repeat(31))).toThrow();
  });
});

describe("project configuration", () => {
  const example = "DACS_DEPLOYMENT=local\nDACS_FIXED_PRICE_AMOUNT=1\nDACS_WALLET_AUTHORITY_URL=\nDACS_X402_FACILITATOR_URL=\n";
  const placeholder = walkthrough.placeholderAuthoritySettings({ port: 40123, tokenFile: "/run/secrets/token", witnessKey: "W".repeat(43) });
  it("sets the named values, appends a missing name and keeps every other line", () => {
    const text = walkthrough.buildEnvFile(example, { DACS_FIXED_PRICE_AMOUNT: "0.000001", DACS_SELLER_PUBLIC_BASE_URL: SELLER_URL });
    expect(text).toContain("DACS_DEPLOYMENT=local\n");
    expect(text).toContain("DACS_FIXED_PRICE_AMOUNT=0.000001\n");
    expect(text).toContain(`DACS_SELLER_PUBLIC_BASE_URL=${SELLER_URL}\n`);
    expect(text).not.toContain("DACS_FIXED_PRICE_AMOUNT=1");
  });
  it("sets all five wallet-authority settings and the loopback flag for the placeholder", () => {
    const text = walkthrough.buildEnvFile(example, placeholder);
    for (const name of ["URL", "ID", "EPOCH", "WITNESS_PUBLIC_KEY", "ALLOW_INSECURE_LOOPBACK"]) {
      expect(text).toMatch(new RegExp(`^DACS_WALLET_AUTHORITY_${name}=.+$`, "m"));
    }
    expect(text).toMatch(/^DACS_BUYER_WALLET_AUTHORITY_TOKEN_FILE=\/run\/secrets\/token$/m);
    expect(text).toContain("DACS_WALLET_AUTHORITY_ALLOW_INSECURE_LOOPBACK=1\n");
  });
  it("gives the placeholder a loopback URL whose path is exactly /", () => {
    const url = new URL(placeholder.DACS_WALLET_AUTHORITY_URL);
    expect([url.hostname, url.pathname, url.port]).toEqual(["127.0.0.1", "/", "40123"]);
  });
  it("refuses a value that would add a line or a comment to the file", () => {
    for (const value of ["a\nDACS_PURCHASE_CONFIRM=1", "a b", "a#b", "'a'"]) {
      expect(() => walkthrough.buildEnvFile(example, { DACS_EVM_RPC_URL: value })).toThrow(/not allowed/);
    }
  });
  it("refuses to write a confirmation variable", () => {
    expect(() => walkthrough.buildEnvFile(example, { DACS_SETUP_WRITE_CONFIRM: "1" })).toThrow(/confirmation/);
    expect(() => walkthrough.buildEnvFile("DACS_PURCHASE_CONFIRM=1\n", {})).toThrow(/confirmation/);
  });
});

describe("Listing draft", () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = rawPublicKey(keys.publicKey);
  const authority = demosAgentClaimRef(publicKey);
  const usdc = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const now = 1_000_000;
  const signer = async (bytes: Uint8Array) => Uint8Array.from(sign(null, bytes, keys.privateKey));
  const build = () => walkthrough.buildListingDraft(
    { sellerAuthority: authority, sellerUrl: SELLER_URL, payee: PAYEE, usdc, now },
    { identityBundleHash, signedBytes, sign: signer },
  );
  const rail = {
    railVersion: 1, railId: "x402:default", railType: "x402",
    asset: { kind: "erc20", chainId: 84_532, contract: usdc, symbol: "USDC", decimals: 6 },
    network: { kind: "x402-resource", resourceBaseUrl: SELLER_URL },
    phaseHandler: "pay-x402", parameters: { authorization: "eip-3009", finalityBlocks: 1 }, availability: "live",
    governance: { proposedBy: authority, acceptedAt: 1, anchoring: "single-signer" },
    signature: { algorithm: "ed25519", signer: authority, value: "A".repeat(86) },
  };
  const inspect = (draft: unknown) => inspectDacsX402ListingDraftV1({
    draft, sellerAuthority: authority, sellerPublicKey: publicKey, sellerPublicEndpoint: SELLER_URL,
    sellerPayee: PAYEE, network: "eip155:84532", rail, maximumServiceAmount: "0.000001", now,
  });
  it("passes the project's own Listing check", async () => {
    expect(inspect(await build())).toMatchObject({ status: "pass", facts: { amount: "0.000001", asset: "USDC" } });
  });
  it("fails the project's own Listing check when one signature byte is changed", async () => {
    const draft = await build();
    const signature = Buffer.from(draft.seller.identity.presentation.signatures[0].signature, "base64url");
    signature[0] = signature[0]! ^ 1;
    draft.seller.identity.presentation.signatures[0].signature = signature.toString("base64url");
    expect(inspect(draft)).toEqual({ status: "fail", reasonCode: "listing-candidate-identity-invalid" });
  });
  it("uses the one normalized seller URL for the endpoint and the rail resource", async () => {
    const draft = await build();
    expect(draft.seller.publicEndpoint).toBe(SELLER_URL);
    expect(draft.acceptedRails[0].parameters.httpResource).toBe(SELLER_URL);
  });
  it("writes the draft once and never overwrites it", () => {
    const file = join(freshDirectory(), "draft.json");
    walkthrough.writeFileOnce(file, "first");
    expect(() => walkthrough.writeFileOnce(file, "second")).toThrow(/EEXIST/);
    expect(readFileSync(file, "utf8")).toBe("first");
    expect(statSync(file).isFile()).toBe(true);
  });
});

describe("registry step", () => {
  it.each([
    [null, false, "plan"], [null, true, "bootstrap"], [{ registryVersion: 1 }, false, "existing"], [{ registryVersion: 1 }, true, "existing"],
  ])("decides %j with confirm=%s as %s", (resolved, confirm, action) => {
    expect(walkthrough.registryAction(resolved, confirm)).toBe(action);
  });
  it("stops when the read does not say absent or present", () => {
    expect(() => walkthrough.registryAction(undefined, true)).toThrow(/unresolved/);
  });
  it("refuses while the seller service answers /health", async () => {
    await expect(walkthrough.sellerServiceRunning("http://127.0.0.1:3102/health", reply("{}"))).resolves.toBe(true);
  });
  it("treats a refused connection as not running", async () => {
    const refused = (async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }) as typeof fetch;
    await expect(walkthrough.sellerServiceRunning("http://127.0.0.1:3102/health", refused)).resolves.toBe(false);
  });
  it("does not treat a timeout as not running", async () => {
    const slow = (async () => { throw new DOMException("timed out", "TimeoutError"); }) as typeof fetch;
    await expect(walkthrough.sellerServiceRunning("http://127.0.0.1:3102/health", slow)).rejects.toThrow(/timed out/);
  });
});

describe("child steps", () => {
  it("removes every DACS_ variable from the child environment, so the project's .env decides", () => {
    const env = walkthrough.childEnvironment({
      PATH: "/bin", DACS_SETUP_WRITE_CONFIRM: "1", DACS_PURCHASE_CONFIRM: "1", DACS_SELLER_PUBLIC_BASE_URL: "https://other.example/x", NOT_DACS_X: "1",
    });
    expect(env).toEqual({ PATH: "/bin", NOT_DACS_X: "1" });
  });
  it("reads one JSON object of public values from the child output", () => {
    expect(walkthrough.parseChildSummary('{"a":"b"}\n')).toEqual({ a: "b" });
  });
  it.each(["", "not json", '{"a":1}\n{"b":2}\n', "[1]"])("refuses child output that is not one JSON object: %j", (text) => {
    expect(() => walkthrough.parseChildSummary(text)).toThrow(/summary/);
  });
});

const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;

function runScript(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A run directory with a generated, installed project; `options` break one thing at a time. */
function initFixture(options: { env?: boolean; built?: boolean; installed?: string } = {}) {
  const run = freshDirectory();
  const project = join(run, "project");
  mkdirSync(join(project, "dist/src"), { recursive: true });
  mkdirSync(join(run, "packs"));
  for (const name of ["create-dacs-agent", "kynesyslabs-dacs", "kynesyslabs-dacs-node"]) writeFileSync(join(run, "packs", `${name}-${version}.tgz`), name);
  if (options.built !== false) writeFileSync(join(project, "dist/src/config.js"), "");
  if (options.env === true) writeFileSync(join(project, ".env"), "");
  writeFileSync(join(project, ".env.example"), "DACS_DEPLOYMENT=local\nDACS_X402_LISTING_DRAFT_FILE=./listing-draft-x402.json\n");
  for (const name of ["dacs", "dacs-node"]) {
    mkdirSync(join(project, "node_modules/@kynesyslabs", name), { recursive: true });
    writeFileSync(join(project, "node_modules/@kynesyslabs", name, "package.json"), JSON.stringify({ version: options.installed ?? version }));
  }
  return run;
}

const initArguments = (run: string, overrides: Record<string, string> = {}) => {
  const options = { "--run-dir": run, "--seller-url": SELLER_URL, "--evm-rpc": "https://rpc.example/key", ...overrides };
  return ["init", ...Object.entries(options).flat()];
};

describe("init refuses before anything is written", () => {
  const refuses = (run: string, args: string[], message: RegExp) => {
    const result = runScript(args);
    expect(result.stderr).toMatch(message);
    expect(result.status).toBe(1);
    expect(existsSync(join(run, "secrets"))).toBe(false);
    expect(readdirSync(run).sort()).toEqual(["packs", "project"]);
  };
  it("refuses a project that already has a .env", () => {
    const run = initFixture({ env: true });
    refuses(run, initArguments(run), /project\/\.env already exists; generate a new project/);
  });
  it("refuses a project that is not built", () => {
    const run = initFixture({ built: false });
    refuses(run, initArguments(run), /not built; run npm run build inside project\//);
  });
  it("refuses a seller URL with a root path", () => {
    const run = initFixture();
    refuses(run, initArguments(run, { "--seller-url": "https://seller.example" }), /needs a path/);
  });
  it.each(["https://rpc.example/#key", "https://rpc.example/'key'", "https://rpc.example/a\\b"])("refuses an EVM RPC .env cannot hold: %s", (rpc) => {
    const run = initFixture();
    refuses(run, initArguments(run, { "--evm-rpc": rpc }), /value for DACS_EVM_RPC_URL is not allowed in \.env/);
  });
  it("refuses an installed package whose version is not the tarball version", () => {
    const run = initFixture({ installed: "0.0.1" });
    refuses(run, initArguments(run), new RegExp(`installed @kynesyslabs/dacs is not version ${version.replace(/\./g, "\\.")}`));
  });
});

describe("registry step in a stubbed project", () => {
  const usdc = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  /** A loopback port with nothing listening, so the seller health check is refused. */
  const closedPort = () => new Promise<number>((resolvePort) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolvePort(port));
    });
  });
  async function stubRun() {
    const port = await closedPort();
    const run = freshDirectory();
    const project = join(run, "project");
    const write = (path: string, text: string) => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text);
    };
    write(join(project, "package.json"), '{"type":"module"}');
    write(join(project, "dist/src/config.js"), `
      export const serviceEndpoint = () => "http://127.0.0.1:${port}";
      export const configuredAuthority = () => "did:demos:agent:${"a".repeat(64)}";
      export const actorSecretPath = () => "/unused";
      export const loadRoleConfig = () => ({ limits: { maxDemosNetworkFeeDem: 1 } });
      export const configuredListingDraftFile = () => ${JSON.stringify(join(run, "draft.json"))};
      export const configuredSellerEvmPayee = () => "0x${"2".repeat(40)}";`);
    write(join(project, "node_modules/@kynesyslabs/dacs/dist/index.js"), `
      export const RAIL_REGISTRY_INDEX_ADDRESS = "dacs4:registry:v0.1";
      export const resolveRail = async () => ({ network: { resourceBaseUrl: ${JSON.stringify(SELLER_URL)} }, asset: { contract: ${JSON.stringify(usdc)} } });
      export const identityBundleHash = () => "hash";
      export const signedBytes = () => new Uint8Array(1);`);
    write(join(project, "node_modules/@kynesyslabs/dacs-node/dist/index.js"), `
      export const DACS_DEMOS_RAIL_REGISTRY_CURRENT_BINDING_ADDRESS_V1 = "binding";
      export const loadDacsSecretV1 = async () => ({});
      export const bootstrapDacsDemosX402RailRegistryV1 = async () => { throw new Error("must not bootstrap"); };
      export const createDacsDemosActorRuntimeV1 = async () => ({
        publicKey: "key", chainIdentity: async () => "chain-1", signComponent: async () => new Uint8Array(64),
      });
      export const createDacsDemosRailRegistryProviderV1 = () => ({
        resolveCurrentIndex: async () => {
          if (process.env.STUB_REGISTRY_FAILS) throw new Error("registry read failed", { cause: new Error("socket closed") });
          return { registryVersion: 1, indexRef: { contentHash: "index-hash" }, receipt: {} };
        },
        readAnchoredJson: async () => ({ entries: [{ contentHash: "definition-hash" }] }),
      });`);
    writeFileSync(join(run, "state.json"), JSON.stringify({ init: { sellerUrl: SELLER_URL, usdc, acceptedAt: 1 } }));
    return run;
  }
  it("records the registry refs of an existing registry that an earlier run never saved", async () => {
    const run = await stubRun();
    const result = runScript(["internal-registry", "--run-dir", run]);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ rail: "existing", draft: "written", chainIdentity: "chain-1" });
    expect(walkthrough.readState(run).registry).toEqual({ chainIdentity: "chain-1", refs: { definition: "definition-hash", index: "index-hash" } });
  });
  it("prints the cause of a failure after its message", async () => {
    const result = runScript(["internal-registry", "--run-dir", await stubRun()], { STUB_REGISTRY_FAILS: "1" });
    expect(result.stderr.trim()).toBe("registry read failed: socket closed");
    expect(result.status).toBe(1);
  });
});

describe("record arguments", () => {
  const ref = `stor-${"a".repeat(40)}`;
  it("takes --run-dir and an optional Listing ref", () => {
    expect(walkthrough.parseArguments(["record", "--run-dir", "/r"])).toMatchObject({ command: "record", runDir: "/r", listingRef: undefined });
    expect(walkthrough.parseArguments(["record", "--run-dir", "/r", "--listing-ref", ref]).listingRef).toBe(ref);
  });
  it.each(["stor-abc", `stor-${"A".repeat(40)}`, "https://seller.example/listing"])("refuses a Listing ref that is not a storage reference: %s", (value) => {
    expect(() => walkthrough.parseArguments(["record", "--run-dir", "/r", "--listing-ref", value])).toThrow(/storage reference/);
  });
  it.each([
    [["record"], /--run-dir is required/],
    [["record", "--run-dir", "/r", "--confirm"], /unknown option/],
    [["record", "--run-dir", "/r", "--evm-rpc", "https://rpc.example"], /unknown option/],
  ])("refuses bad options: %j", (argv, message) => {
    expect(() => walkthrough.parseArguments(argv)).toThrow(message);
  });
});

const doctorText = (exit: number, checks: string[]) => [
  "dacs doctor", "phase: post-start", "scope: buy", `gate: ${exit === 0 ? "pass" : "blocked"}`, ...checks, `report: ${"c".repeat(64)}`, `exit: ${exit}`, "",
].join("\n");
const BLOCKED_CHECKS = [
  "required local.secrets: pass",
  "required demos.listing-existing: blocked (listing-not-found)",
  "required x402.service-limit: blocked (authority-unreachable) [cause: econnrefused]",
  "informational service.public-reachability: fail",
];
const PLAN_LINE = `${JSON.stringify({ execute: false, invocationMode: "new" })}\n`;

describe("buy output", () => {
  it("lists every check that did not pass, with its reason code", () => {
    expect(walkthrough.parseBuyOutput(doctorText(5, BLOCKED_CHECKS), 5)).toEqual({
      planned: false,
      notPass: [
        { id: "demos.listing-existing", status: "blocked", reasonCode: "listing-not-found" },
        { id: "x402.service-limit", status: "blocked", reasonCode: "authority-unreachable" },
        { id: "service.public-reachability", status: "fail" },
      ],
    });
  });
  it("reads a passing doctor followed by the plan line", () => {
    expect(walkthrough.parseBuyOutput(`${doctorText(0, ["required local.secrets: pass"])}${PLAN_LINE}`, 0)).toEqual({ planned: true, notPass: [] });
  });
  it.each([
    ["no doctor header", doctorText(5, BLOCKED_CHECKS).replace("dacs doctor\n", ""), 5],
    ["an exit line that differs from the exit code", doctorText(5, BLOCKED_CHECKS), 1],
    ["a passing doctor and no plan line", doctorText(0, ["required local.secrets: pass"]), 0],
    ["a check line it cannot read", doctorText(5, ["required local.secrets: maybe"]), 5],
    ["no output", "", 1],
  ])("refuses %s", (_name, text, exitCode) => {
    expect(() => walkthrough.parseBuyOutput(text, exitCode)).toThrow(/buy output/);
  });
});

describe("readiness reading", () => {
  const refused = () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); };
  const read = (fetchImpl: unknown) => walkthrough.readReadiness("http://127.0.0.1:1/ready", fetchImpl);
  it("records the status code and reason codes of a service that is not ready", async () => {
    const body = { ready: false, checkedAt: 1, reasonCodes: ["readiness-latch-missing"] };
    expect(await read(reply(body, { status: 503 }))).toEqual({ status: "blocked", code: 503, reasonCodes: ["readiness-latch-missing"] });
  });
  it("records a ready service", async () => {
    expect(await read(reply({ ready: true, checkedAt: 1, reasonCodes: [] }))).toEqual({ status: "ran", code: 200, reasonCodes: [] });
  });
  it("reports a service that does not answer as unrun", async () => {
    expect(await read(refused)).toEqual({ status: "unrun", reason: "the service did not answer (connection refused)" });
  });
  it.each(["not json", JSON.stringify({ reasonCodes: ["Not A Code"] }), JSON.stringify({ reasonCodes: "x" })])("reports an unreadable reply as unrun without quoting it: %s", async (body) => {
    const result = await read(reply(body, { status: 503 }));
    expect(result).toEqual({ status: "unrun", reason: "the reply of /ready could not be read" });
  });
});

describe("record", () => {
  const ref = `stor-${"b".repeat(40)}`;
  const usdc = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const seller = `did:demos:agent:${"b".repeat(64)}`;
  const walletWords = Array.from({ length: 12 }, (_, index) => "fixtureword" + String(index)).join(" ");
  const providerKey = "provider-key-1234";
  const refused = () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); };
  const notReady = () => Response.json({ ready: false, checkedAt: 1, reasonCodes: ["readiness-latch-missing"] }, { status: 503 });
  const ready = () => Response.json({ ready: true, checkedAt: 1, reasonCodes: [] });

  /** A run directory that init and registry would have left, with the secrets and provider key a record must not copy. */
  function recordFixture(demosRpc = "https://node2.demos.sh") {
    const run = freshDirectory();
    const project = join(run, "project");
    for (const directory of [project, join(run, "packs"), join(run, "logs"), join(run, "secrets")]) mkdirSync(directory);
    const tarballs: Record<string, string> = {};
    for (const name of ["create-dacs-agent", "kynesyslabs-dacs", "kynesyslabs-dacs-node"]) {
      writeFileSync(join(run, "packs", `${name}-${version}.tgz`), name);
      tarballs[`${name}-${version}.tgz`] = createHash("sha256").update(name).digest("hex");
    }
    writeFileSync(join(run, "secrets", "buyer-demos"), walletWords);
    writeFileSync(join(project, ".env.example"), "DACS_DEPLOYMENT=local\nDACS_X402_LISTING_DRAFT_FILE=./listing-draft-x402.json\n");
    writeFileSync(join(project, ".env"), [
      "DACS_DEPLOYMENT=local", `DACS_DEMOS_RPC_URL=${demosRpc}`, `DACS_EVM_RPC_URL=https://rpc.example/v2/${providerKey}?token=1`,
      "DACS_BUYER_SERVICE_URL=http://127.0.0.1:3101", "DACS_SELLER_SERVICE_URL=http://127.0.0.1:3102",
      `DACS_BUYER_AUTHORITY=did:demos:agent:${"a".repeat(64)}`, `DACS_SELLER_AUTHORITY=${seller}`, `DACS_RAIL_STEWARD_AUTHORITY=${seller}`,
      `DACS_SELLER_EVM_PAYEE=${PAYEE}`, `DACS_BUYER_DEMOS_SECRET_FILE=${join(run, "secrets", "buyer-demos")}`, "",
    ].join("\n"));
    writeFileSync(join(run, "state.json"), JSON.stringify({
      init: { commit: "c".repeat(40), packageVersion: version, tarballs, acceptedAt: 1, usdc, sellerUrl: SELLER_URL },
      registry: { chainIdentity: "chain-1", refs: { definition: "d".repeat(64), index: "e".repeat(64) } },
    }));
    return run;
  }

  /** Answers the chain-id read, and /ready on each role's port. */
  const network = (chainId: string, answers: { "3101": () => Response; "3102": () => Response }) => (async (url: string) => {
    if (url.startsWith("https://rpc.example")) return Response.json({ jsonrpc: "2.0", id: 1, result: chainId });
    return answers[String(new URL(url).port) as "3101"]();
  }) as unknown as typeof fetch;
  const onBaseSepolia = network("0x14a34", { "3101": notReady, "3102": notReady });

  /** Puts a stand-in `npm` first on PATH. It saves its arguments, the DACS_ variables it was given and its directory name. */
  function standInNpm(exitCode: number, output: string) {
    const bin = freshDirectory();
    const seen = join(bin, "seen.txt");
    writeFileSync(join(bin, "output.txt"), output);
    writeFileSync(join(bin, "npm"), [
      "#!/bin/sh", `printf '%s\\n' "$@" > ${JSON.stringify(seen)}`, `env | grep -c '^DACS_' >> ${JSON.stringify(seen)}`,
      `basename "$PWD" >> ${JSON.stringify(seen)}`, `cat ${JSON.stringify(join(bin, "output.txt"))}`, `exit ${exitCode}`, "",
    ].join("\n"), { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
    vi.stubEnv("DACS_PURCHASE_CONFIRM", "1");
    return { seen: () => (existsSync(seen) ? readFileSync(seen, "utf8").trim().split("\n") : undefined) };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const quietly = () => vi.spyOn(console, "log").mockImplementation(() => undefined);

  it("runs the buy without a confirmation variable and records each check that did not pass", async () => {
    const print = quietly();
    const npm = standInNpm(5, doctorText(5, BLOCKED_CHECKS));
    const run = recordFixture();
    const record = await walkthrough.record({ runDir: run, listingRef: ref }, onBaseSepolia);
    expect(npm.seen()).toEqual([
      "run", "dacs:buy", "--silent", "--", "--listing-ref", ref, "--request-file", "./request.json",
      "--max-service-amount", "0.000001", "--max-network-fee-eth", "0.001", "0", "project",
    ]);
    expect(record.steps).toEqual({
      init: { status: "ran" }, registry: { status: "ran" },
      readiness: { status: "blocked", reasonCodes: ["readiness-latch-missing"] },
      setup: { status: "unrun", reason: "the Listing ref could not be confirmed because the buy did not pass" },
      buy: {
        status: "blocked", exitCode: 5,
        notPass: [
          { id: "demos.listing-existing", status: "blocked", reasonCode: "listing-not-found" },
          { id: "x402.service-limit", status: "blocked", reasonCode: "authority-unreachable" },
          { id: "service.public-reachability", status: "fail" },
        ],
      },
      fundedPurchase: { status: "unrun", reason: expect.stringContaining("wallet-spend authority") },
    });
    expect(record.fundedRun).toMatch(/^Funded run: UNRUN — /);
    expect(record).toMatchObject({ listingRef: ref, readiness: { buyer: { code: 503 }, seller: { code: 503 } } });
    expect(print).toHaveBeenCalledWith(JSON.stringify(record));
    expect(JSON.parse(readFileSync(join(run, "record.json"), "utf8"))).toEqual(record);
    expect(statSync(join(run, "record.json")).mode & 0o777).toBe(0o600);
  });

  it("records a passing plan-only buy as ran", async () => {
    quietly();
    standInNpm(0, `${doctorText(0, ["required local.secrets: pass"])}${PLAN_LINE}`);
    const record = await walkthrough.record({ runDir: recordFixture(), listingRef: ref }, network("0x14a34", { "3101": ready, "3102": ready }));
    expect(record.steps).toMatchObject({
      readiness: { status: "ran" }, buy: { status: "ran", planOnly: true },
      setup: { status: "ran", evidence: "the buy found the Listing" },
    });
  });

  it("keeps no key, secret, absolute path or URL path", async () => {
    quietly();
    standInNpm(5, doctorText(5, BLOCKED_CHECKS));
    const run = recordFixture("https://demos.example/node-key-5678");
    await walkthrough.record({ runDir: run, listingRef: ref }, onBaseSepolia);
    const text = readFileSync(join(run, "record.json"), "utf8");
    for (const secret of [...walletWords.split(" "), providerKey, "node-key-5678", "token=1", "/v2/", run, tmpdir(), "secrets"]) expect(text).not.toContain(secret);
    expect(JSON.parse(text)).toMatchObject({
      evmRpc: { host: "rpc.example" }, demosRpc: { host: "custom", chainIdentity: "chain-1" },
      deployment: "local", rails: ["x402"], authorities: { seller, steward: seller }, payee: PAYEE,
      registry: { definition: "d".repeat(64), index: "e".repeat(64) },
    });
  });

  it("names the default Demos host and no chain identity", async () => {
    quietly();
    const record = await walkthrough.record({ runDir: recordFixture() }, onBaseSepolia);
    expect(record.demosRpc).toEqual({ host: "node2.demos.sh" });
  });

  it("runs no buy without a Listing ref, and reports setup and buy as unrun with the reason", async () => {
    quietly();
    const npm = standInNpm(0, "");
    const record = await walkthrough.record({ runDir: recordFixture() }, onBaseSepolia);
    expect(npm.seen()).toBeUndefined();
    expect(record.steps.setup).toEqual({ status: "unrun", reason: "the Listing ref could not be confirmed because the buy was not run" });
    expect(record.steps.buy).toEqual({ status: "unrun", reason: "needs --listing-ref, the Listing ref that dacs:setup prints" });
    expect(record.listingRef).toBeUndefined();
  });

  it("reports a role service that does not answer as unrun and still records the other role", async () => {
    quietly();
    const record = await walkthrough.record({ runDir: recordFixture() }, network("0x14a34", { "3101": notReady, "3102": refused }));
    expect(record.readiness).toEqual({
      buyer: { status: "blocked", code: 503, reasonCodes: ["readiness-latch-missing"] },
      seller: { status: "unrun", reason: "the service did not answer (connection refused)" },
    });
    expect(record.steps.readiness).toEqual({ status: "unrun", reason: "a role service was not observed" });
  });

  it("reports a registry step that saved no refs as unrun", async () => {
    quietly();
    const run = recordFixture();
    const state = walkthrough.readState(run);
    delete state.registry;
    walkthrough.writeState(run, state);
    const record = await walkthrough.record({ runDir: run }, onBaseSepolia);
    expect(record.steps.registry).toEqual({ status: "unrun", reason: "the registry step has not saved its refs; run registry first" });
    expect(record.registry).toBeUndefined();
  });

  it("adds only record.json and the buy log, and writes no readiness record or doctor report", async () => {
    quietly();
    standInNpm(5, doctorText(5, BLOCKED_CHECKS));
    const run = recordFixture();
    await walkthrough.record({ runDir: run, listingRef: ref }, onBaseSepolia);
    expect(readdirSync(run).sort()).toEqual(["logs", "packs", "project", "record.json", "secrets", "state.json"]);
    expect(readdirSync(join(run, "logs"))).toEqual(["buy.log"]);
    expect(readdirSync(join(run, "project")).sort()).toEqual([".env", ".env.example"]);
  });

  it("replaces record.json on a rerun", async () => {
    quietly();
    const run = recordFixture();
    await walkthrough.record({ runDir: run }, onBaseSepolia);
    const record = await walkthrough.record({ runDir: run }, network("0x14a34", { "3101": ready, "3102": ready }));
    expect(JSON.parse(readFileSync(join(run, "record.json"), "utf8"))).toEqual(record);
    expect(record.steps.readiness).toEqual({ status: "ran" });
    expect(readdirSync(run)).not.toContain("record.json.tmp");
  });

  describe("refuses and writes no record", () => {
    const refuses = async (run: string, message: RegExp, fetchImpl: typeof fetch = onBaseSepolia, listingRef?: string) => {
      await expect(walkthrough.record({ runDir: run, listingRef }, fetchImpl)).rejects.toThrow(message);
      expect(existsSync(join(run, "record.json"))).toBe(false);
    };
    it("before init", async () => {
      const run = recordFixture();
      rmSync(join(run, "state.json"));
      await refuses(run, /run init first/);
    });
    it("when the EVM chain is not Base Sepolia", async () => {
      await refuses(recordFixture(), /not 84532/, network("0x1", { "3101": notReady, "3102": notReady }));
    });
    it("when a tarball no longer matches the hash saved by init, before it runs the buy", async () => {
      const npm = standInNpm(5, doctorText(5, BLOCKED_CHECKS));
      const run = recordFixture();
      writeFileSync(join(run, "packs", `kynesyslabs-dacs-${version}.tgz`), "changed");
      await refuses(run, new RegExp(`tarball kynesyslabs-dacs-${version.replace(/\./g, "\\.")}\\.tgz no longer matches`), onBaseSepolia, ref);
      expect(npm.seen()).toBeUndefined();
    });
    it("when the buy prints something other than a doctor report", async () => {
      standInNpm(1, "listing reference is malformed\n");
      await refuses(recordFixture(), /buy output/, onBaseSepolia, ref);
    });
    it("when the project's .env is missing", async () => {
      const run = recordFixture();
      rmSync(join(run, "project", ".env"));
      await refuses(run, /project\/\.env is missing/);
    });
    it("when an authority in .env is not an authority", async () => {
      const run = recordFixture();
      const file = join(run, "project", ".env");
      writeFileSync(file, readFileSync(file, "utf8").replace(`DACS_SELLER_AUTHORITY=${seller}`, "DACS_SELLER_AUTHORITY=seller"));
      await refuses(run, /DACS_SELLER_AUTHORITY in project\/\.env is not an authority/);
    });
  });
});
