import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const authenticated = vi.hoisted(() => ({ value: true }));
vi.mock("@kynesyslabs/dacs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kynesyslabs/dacs")>()),
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

const SELLER_URL = "https://seller.example/";
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
  });  it("refuses an EVM RPC that is not HTTPS", () => {
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
    expect(walkthrough.normalizeSellerUrl("https://Seller.Example")).toBe("https://seller.example/");
  });
  it.each(["http://seller.example/", "https://u:p@seller.example/", "https://seller.example/?q=1", "https://seller.example/#x", "seller.example"])(
    "refuses a seller URL that is not plain HTTPS: %s", (value) => {
      expect(() => walkthrough.normalizeSellerUrl(value)).toThrow();
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
  it("removes every confirmation variable from the child environment", () => {
    const env = walkthrough.childEnvironment({ PATH: "/bin", DACS_SETUP_WRITE_CONFIRM: "1", DACS_PURCHASE_CONFIRM: "1", DACS_X: "1" });
    expect(env).toEqual({ PATH: "/bin", DACS_X: "1" });
  });
  it("reads one JSON object of public values from the child output", () => {
    expect(walkthrough.parseChildSummary('{"a":"b"}\n')).toEqual({ a: "b" });
  });
  it.each(["", "not json", '{"a":1}\n{"b":2}\n', "[1]"])("refuses child output that is not one JSON object: %j", (text) => {
    expect(() => walkthrough.parseChildSummary(text)).toThrow(/summary/);
  });
});
