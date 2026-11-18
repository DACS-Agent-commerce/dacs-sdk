#!/usr/bin/env node
// Run script for a testnet walkthrough of a generated live project (x402 rail, local deployment).
//
// Usage. The run directory holds packs/ (three tarballs from this checkout) and an installed project/:
//   node scripts/fixed-price-x402-walkthrough.mjs init --run-dir <dir> --seller-url <https-url> --evm-rpc <https-url>
//   node scripts/fixed-price-x402-walkthrough.mjs registry --run-dir <dir> [--confirm]
//
// Testnet only. It never sets a confirmation variable and never runs the project's setup or buy commands.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const CHECKOUT = resolve(dirname(SCRIPT), "..");
const CHAIN_ID = 84532;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const FACILITATOR = "https://x402.org/facilitator";
const PRICE = "0.000001";
const REPLY_LIMIT_BYTES = 65_536;
const REQUEST_TIMEOUT_MS = 10_000;
const CHILD_TIMEOUT_MS = 600_000;
const CHILD_OUTPUT_LIMIT_BYTES = 1_048_576;
const AUTHORITY_RE = /^did:demos:agent:[0-9a-f]{64}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const VALUED_OPTIONS = {
  init: ["--run-dir", "--seller-url", "--evm-rpc"],
  registry: ["--run-dir"],
  "internal-keys": ["--run-dir"],
  "internal-registry": ["--run-dir"],
};

/** Parse one command line into its command and options; throws on anything unknown, repeated or missing. */
export function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!Object.hasOwn(VALUED_OPTIONS, String(command))) throw new Error(`unknown command: ${command ?? "(none)"}`);
  const valued = VALUED_OPTIONS[command];
  const values = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    const flag = name === "--confirm" && command.endsWith("registry");
    if (!flag && !valued.includes(name)) throw new Error(`unknown option: ${name}`);
    if (values.has(name)) throw new Error(`option repeated: ${name}`);
    const value = flag ? true : rest[(index += 1)];
    if (value === undefined || String(value).startsWith("--")) throw new Error(`${name} needs a value`);
    values.set(name, value);
  }
  const missing = valued.find((name) => !values.has(name));
  if (missing !== undefined) throw new Error(`${missing} is required`);
  const evmRpc = values.get("--evm-rpc");
  if (evmRpc !== undefined && !/^https:\/\//.test(evmRpc)) throw new Error("--evm-rpc must be an HTTPS URL");
  return { command, runDir: values.get("--run-dir"), sellerUrl: values.get("--seller-url"), evmRpc, confirm: values.get("--confirm") === true };
}

/** Return the real path of a run directory that is outside the checkout, owned by the user, mode 0700. */
export function checkRunDirectory(runDir, checkout = CHECKOUT) {
  const real = realpathSync(resolve(runDir));
  const fromCheckout = relative(realpathSync(checkout), real);
  const outside = fromCheckout === ".." || fromCheckout.startsWith(`..${sep}`) || isAbsolute(fromCheckout);
  if (!outside) throw new Error("run directory is inside the checkout");
  const info = statSync(real);
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid()) {
    throw new Error("run directory must be a directory with mode 0700 owned by you");
  }
  return real;
}

/** Return the saved state, or an empty object when init has not written one. */
export function readState(runDir) {
  const file = join(runDir, "state.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

/** Replace state.json atomically: write a new file, then rename it over the old one. */
export function writeState(runDir, state) {
  const temporary = join(runDir, `state.json.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temporary, join(runDir, "state.json"));
}

/** Refuse init on a run directory that already has secrets or a saved init. */
export function checkFreshInit(runDir) {
  if (existsSync(join(runDir, "secrets"))) throw new Error("secrets already exists; use a new run directory");
  if (readState(runDir).init !== undefined) throw new Error("init already ran; use a new run directory");
}

/** Create a file that must not exist yet. The content appears whole or not at all. */
export function writeFileOnce(path, text) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { flag: "wx", mode: 0o644 });
  try { linkSync(temporary, path); } finally { unlinkSync(temporary); }
}

/** Read a reply body, refusing it as soon as it passes the byte limit. */
export async function readBounded(response, limit = REPLY_LIMIT_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit) throw new Error("reply is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Call an EVM JSON-RPC method that takes no parameters and returns a hex number; the reply is bounded. */
export async function readRpcNumber(url, method, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    method: "POST", headers: { "content-type": "application/json" }, redirect: "error",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${method} failed with HTTP ${response.status}`);
  const result = JSON.parse(await readBounded(response))?.result;
  const number = typeof result === "string" && /^0x[0-9a-f]+$/.test(result) ? Number.parseInt(result, 16) : NaN;
  if (!Number.isSafeInteger(number)) throw new Error(`${method} reply is not a hex number`);
  return number;
}

/** Throw unless the EVM RPC reports Base Sepolia. */
export async function assertBaseSepolia(rpcUrl, fetchImpl = fetch) {
  const chainId = await readRpcNumber(rpcUrl, "eth_chainId", fetchImpl);
  if (chainId !== CHAIN_ID) throw new Error(`EVM chain id is ${chainId}, not ${CHAIN_ID} (Base Sepolia)`);
}

/** Return the seller URL in the one normalized form every later use shares. */
export function normalizeSellerUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || /[?#]/.test(value)) {
    throw new Error("seller URL must be plain HTTPS without userinfo, query or fragment");
  }
  return url.toString();
}

/** Turn a Demos key or address (any case, optional 0x) into the authority form the project requires. */
export function normalizeAuthority(value) {
  const hex = value.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("authority key must be 64 hex digits");
  return `did:demos:agent:${hex}`;
}

/** Settings for a placeholder wallet-spend authority: a loopback URL with no service behind it and a random witness key whose private half is never created. */
export function placeholderAuthoritySettings({ port, tokenFile, witnessKey }) {
  return {
    DACS_WALLET_AUTHORITY_URL: `http://127.0.0.1:${port}/`,
    DACS_WALLET_AUTHORITY_ID: "unpayable-placeholder",
    DACS_WALLET_AUTHORITY_EPOCH: "placeholder-1",
    DACS_WALLET_AUTHORITY_WITNESS_PUBLIC_KEY: witnessKey,
    DACS_WALLET_AUTHORITY_ALLOW_INSECURE_LOOPBACK: "1",
    DACS_BUYER_WALLET_AUTHORITY_TOKEN_FILE: tokenFile,
  };
}

/** Copy the generated example and set the named values; every other line is kept. */
export function buildEnvFile(example, values) {
  if (/^\s*(?:export\s+)?DACS_\w*_CONFIRM\s*=/m.test(example) || Object.keys(values).some((name) => name.endsWith("_CONFIRM"))) {
    throw new Error("a confirmation variable is never written to .env");
  }
  let text = example.endsWith("\n") ? example : `${example}\n`;
  for (const [name, value] of Object.entries(values)) {
    if (!/^[^\s#'"`\\]+$/.test(value)) throw new Error(`value for ${name} is not allowed in .env`);
    const line = new RegExp(`^${name}=.*\n`, "m");
    text = line.test(text) ? text.replace(line, () => `${name}=${value}\n`) : `${text}${name}=${value}\n`;
  }
  return text;
}

/** Build the seller's x402 Listing draft; the seller identity is signed through the given signer. */
export async function buildListingDraft({ sellerAuthority, sellerUrl, payee, usdc, now }, { identityBundleHash, signedBytes, sign }) {
  const bundle = {
    bundleVersion: "1", presentedBy: sellerAuthority, presentedAt: now, claims: [{ ref: sellerAuthority }],
    presentation: { kind: "per-claim", signatures: [{ ref: sellerAuthority, signature: "pending" }] },
  };
  const signature = await sign(signedBytes("dacs-bundle-presentation:v1:", identityBundleHash(bundle)));
  if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new Error("seller signature is not 64 bytes");
  bundle.presentation.signatures[0].signature = Buffer.from(signature).toString("base64url");
  return {
    dacsVersion: "1", listingVersion: 1, listingId: "fixed-price-walkthrough",
    seller: { identity: bundle, displayName: "Walkthrough seller", publicEndpoint: sellerUrl },
    offering: {
      title: "Walkthrough result", description: "A bounded application result for a testnet walkthrough",
      category: "software.service", tags: ["dacs"], deliverable: { kind: "storage-program", accessModel: "public" },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" }, { kind: "commit-payee-bound-agreement" },
      { kind: "pay-x402", parameters: { rail: "x402:default" } }, { kind: "deliver-storage-program" },
    ],
    pricing: { kind: "fixed", price: { amount: PRICE, currency: "USDC" } },
    acceptedRails: [{
      railId: "x402:default", railVersion: 1,
      parameters: { network: `eip155:${CHAIN_ID}`, payTo: payee, asset: usdc, httpResource: sellerUrl },
    }],
    terms: { deadlineSecAfterCommit: 3600 },
    validity: { notBefore: now },
  };
}

/** Decide the registry step from the read-only lookup: null means no registry yet; anything else is an existing one. */
export function registryAction(resolved, confirm) {
  if (resolved === undefined) throw new Error("registry read is unresolved");
  if (resolved !== null) return "existing";
  return confirm ? "bootstrap" : "plan";
}

const connectionRefused = (error) => error?.cause?.code === "ECONNREFUSED";

/** True when something answers at the URL; a refused connection is false; a timeout is an error. */
export async function sellerServiceRunning(url, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: "error" });
    await response.body?.cancel();
    return true;
  } catch (error) {
    if (connectionRefused(error)) return false;
    throw error;
  }
}

/** Copy of the environment without any confirmation variable. */
export function childEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^DACS_\w*_CONFIRM$/.test(name)));
}

/** Parse a child's stdout: exactly one JSON object on one line. */
export function parseChildSummary(text) {
  const lines = text.split("\n").filter((line) => line !== "");
  const value = lines.length === 1 ? (() => { try { return JSON.parse(lines[0]); } catch { return undefined; } })() : undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("child summary is not one JSON object");
  return value;
}

function git(...args) {
  const result = spawnSync("git", ["-C", CHECKOUT, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.trim();
}

function assertSupportedNode() {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  const supported = major === 22 ? minor > 22 || (minor === 22 && patch >= 2) : major === 24 && minor >= 15;
  if (!supported) throw new Error("Node ^22.22.2 or ^24.15.0 is required");
}

function hashTarballs(run, version) {
  const expected = ["create-dacs-agent", "kynesyslabs-dacs", "kynesyslabs-dacs-node"].map((name) => `${name}-${version}.tgz`).sort();
  const found = readdirSync(join(run, "packs")).sort();
  if (found.join() !== expected.join()) throw new Error(`packs must hold exactly ${expected.join(", ")}`);
  return Object.fromEntries(found.map((name) => [name, createHash("sha256").update(readFileSync(join(run, "packs", name))).digest("hex")]));
}

const freeLoopbackPort = () => new Promise((resolvePort, reject) => {
  const server = createServer().once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolvePort(port));
  });
});

// Steps that need demosdk, viem or dacs-node run this file again inside the project, with the project's loader.
// The child's raw output goes to logs/<step>.log; only its one-line summary of public values is used.
function runChild(run, step, args) {
  const argv = ["--import", "@kynesyslabs/dacs-node/demos-loader", SCRIPT, `internal-${step}`, "--run-dir", run, ...args];
  const result = spawnSync(process.execPath, argv, {
    cwd: join(run, "project"), env: childEnvironment(process.env), encoding: "utf8", maxBuffer: CHILD_OUTPUT_LIMIT_BYTES, timeout: CHILD_TIMEOUT_MS,
  });
  writeFileSync(join(run, "logs", `${step}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`, { mode: 0o600 });
  if (result.status !== 0) throw new Error(`${step} failed (${result.status ?? result.error?.code ?? result.signal}); see logs/${step}.log`);
  return parseChildSummary(result.stdout);
}

async function init({ runDir, sellerUrl, evmRpc }) {
  assertSupportedNode();
  const run = checkRunDirectory(runDir);
  checkFreshInit(run);
  const url = normalizeSellerUrl(sellerUrl);
  const project = join(run, "project");
  if (git("status", "--porcelain", "--untracked-files=no") !== "") throw new Error("the checkout has tracked changes");
  const { version } = JSON.parse(readFileSync(join(CHECKOUT, "package.json"), "utf8"));
  const tarballs = hashTarballs(run, version);
  const example = readFileSync(join(project, ".env.example"), "utf8");
  const generated = /^DACS_DEPLOYMENT=local$/m.test(example) && !example.includes("DACS_PAY_DEM_LISTING_DRAFT_FILE") &&
    /^DACS_X402_LISTING_DRAFT_FILE=\.\/listing-draft-x402\.json$/m.test(example);
  if (!generated || !existsSync(join(project, "node_modules/@kynesyslabs/dacs-node"))) {
    throw new Error("project/ must be generated with --mode live-demos --rails x402 --deploy local and installed");
  }
  await assertBaseSepolia(evmRpc);
  const searchFromBlock = await readRpcNumber(evmRpc, "eth_blockNumber");
  for (const name of ["secrets", "logs"]) mkdirSync(join(run, name), { mode: 0o700 });
  const keys = runChild(run, "keys", []);
  const secret = (name) => join(run, "secrets", name);
  writeFileSync(secret("buyer-wallet-authority-token"), randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 });
  const values = {
    DACS_BUYER_AUTHORITY: keys.buyerAuthority, DACS_SELLER_AUTHORITY: keys.sellerAuthority,
    DACS_RAIL_STEWARD_AUTHORITY: keys.sellerAuthority, DACS_SELLER_EVM_PAYEE: keys.sellerPayee,
    DACS_BUYER_DEMOS_SECRET_FILE: secret("buyer-demos"), DACS_BUYER_EVM_SECRET_FILE: secret("buyer-evm"),
    DACS_SELLER_DEMOS_SECRET_FILE: secret("seller-demos"), DACS_SELLER_EVM_SECRET_FILE: secret("seller-evm"),
    ...placeholderAuthoritySettings({
      port: await freeLoopbackPort(), tokenFile: secret("buyer-wallet-authority-token"), witnessKey: randomBytes(32).toString("base64url"),
    }),
    DACS_SELLER_PUBLIC_BASE_URL: url, DACS_X402_FACILITATOR_URL: FACILITATOR, DACS_EVM_RPC_URL: evmRpc,
    DACS_X402_AUTHORIZATION_SEARCH_FROM_BLOCK: String(searchFromBlock), DACS_FIXED_PRICE_AMOUNT: PRICE, DACS_MAX_SERVICE_AMOUNT: PRICE,
  };
  const publicValues = [AUTHORITY_RE.test(keys.buyerAuthority), AUTHORITY_RE.test(keys.sellerAuthority), EVM_ADDRESS_RE.test(keys.sellerPayee)];
  if (!publicValues.every(Boolean)) throw new Error("keys step returned an unexpected address");
  writeFileSync(join(project, ".env"), buildEnvFile(example, values), { flag: "wx", mode: 0o600 });
  writeFileSync(join(project, "request.json"), '{"schema":"dacs-generated-purchase-request/v1","input":{"query":"bounded request"}}\n', { flag: "wx" });
  writeState(run, { init: { commit: git("rev-parse", "HEAD"), packageVersion: version, tarballs, acceptedAt: Date.now(), usdc: USDC, sellerUrl: url } });
  console.log(`init done. Fund both Demos addresses, then run registry:\n  buyer  ${keys.buyerAuthority}\n  seller ${keys.sellerAuthority}`);
  for (const authority of [keys.buyerAuthority, keys.sellerAuthority]) console.log(`  curl -s -X POST https://faucetbackend.demos.sh/api/request -H 'Content-Type: application/json' -d '{"address":"0x${authority.slice(-64)}"}'`);
}

// Child of init: generate both Demos mnemonics and both EVM keys straight into owner-only files.
async function generateKeys({ runDir }) {
  const projectRequire = createRequire(join(runDir, "project", "package.json"));
  const load = (name) => import(pathToFileURL(projectRequire.resolve(name)).href);
  const { Demos } = await load("@kynesyslabs/demosdk/websdk");
  const { generatePrivateKey, privateKeyToAccount } = await load("viem/accounts");
  const summary = {};
  for (const role of ["buyer", "seller"]) {
    const demos = new Demos();
    const mnemonic = demos.newMnemonic();
    await demos.connectWallet(mnemonic);
    summary[`${role}Authority`] = normalizeAuthority(demos.getAddress());
    const evmKey = generatePrivateKey();
    if (role === "seller") summary.sellerPayee = privateKeyToAccount(evmKey).address;
    writeFileSync(join(runDir, "secrets", `${role}-demos`), mnemonic, { flag: "wx", mode: 0o600 });
    writeFileSync(join(runDir, "secrets", `${role}-evm`), evmKey, { flag: "wx", mode: 0o600 });
  }
  console.log(JSON.stringify(summary));
}

function registry({ runDir, confirm }) {
  const run = checkRunDirectory(runDir);
  if (readState(run).init === undefined) throw new Error("run init first");
  console.log(JSON.stringify(runChild(run, "registry", confirm ? ["--confirm"] : []), null, 2));
}

// Child of registry: resolve the rail read-only, bootstrap it only with --confirm, then write the signed Listing draft.
async function registryInProject({ runDir, confirm }) {
  const run = checkRunDirectory(runDir);
  const state = readState(run);
  // The packages' export maps have only an import condition, so their package-root files are loaded by path.
  const load = (...segments) => import(pathToFileURL(join(run, "project", ...segments)).href);
  const packageRoot = (name) => load("node_modules", "@kynesyslabs", name, "dist", "index.js");
  const [core, node, config] = [await packageRoot("dacs"), await packageRoot("dacs-node"), await load("dist", "src", "config.js")];
  if (await sellerServiceRunning(`${config.serviceEndpoint("seller")}/health`)) throw new Error("the seller service is running; stop it first");
  const authority = config.configuredAuthority("seller");
  const demosIdentity = await node.loadDacsSecretV1({ name: "seller-setup-demos-identity", mode: "live-demos", filePath: config.actorSecretPath("seller", "demos-identity") });
  const runtime = await node.createDacsDemosActorRuntimeV1({ config: config.loadRoleConfig("seller"), role: "seller", authority, demosIdentity, writePolicy: "perform" });
  const provider = node.createDacsDemosRailRegistryProviderV1({ runtime, stewardAuthority: authority, stewardPublicKey: runtime.publicKey });
  const { sellerUrl, usdc, acceptedAt } = state.init;
  const action = registryAction(await provider.resolveCurrentIndex(core.RAIL_REGISTRY_INDEX_ADDRESS), confirm);
  if (action === "plan") {
    const addresses = ["dacs4:rail:x402%3Adefault:1", core.RAIL_REGISTRY_INDEX_ADDRESS, node.DACS_DEMOS_RAIL_REGISTRY_CURRENT_BINDING_ADDRESS_V1];
    const maxFeeDemPerWrite = config.loadRoleConfig("seller").limits.maxDemosNetworkFeeDem;
    console.log(JSON.stringify({ rail: "plan", steward: authority, resourceBaseUrl: sellerUrl, asset: usdc, acceptedAt, addresses, maxFeeDemPerWrite }));
    return;
  }
  const bootstrapped = action === "bootstrap"
    ? await node.bootstrapDacsDemosX402RailRegistryV1({ runtime, resourceBaseUrl: sellerUrl, assetContract: usdc, acceptedAt }) : undefined;
  const rail = await core.resolveRail(core.RAIL_REGISTRY_INDEX_ADDRESS, "x402:default", provider);
  if (rail.network.resourceBaseUrl !== sellerUrl || rail.asset.contract.toLowerCase() !== usdc.toLowerCase()) {
    throw new Error("the registered rail does not match the values pinned at init");
  }
  const refs = bootstrapped === undefined ? state.registry?.refs
    : { definition: bootstrapped.definitionRef.contentHash, index: bootstrapped.indexRef.contentHash };
  const chainIdentity = await runtime.chainIdentity();
  writeState(run, { ...state, registry: { chainIdentity, refs } });
  const draftPath = config.configuredListingDraftFile("x402");
  const draft = existsSync(draftPath) ? "present" : "written";
  if (draft === "written") {
    const signer = (bytes) => runtime.signComponent(bytes, { algorithm: "ed25519", signer: authority });
    const listing = await buildListingDraft(
      { sellerAuthority: authority, sellerUrl, payee: config.configuredSellerEvmPayee(), usdc, now: Date.now() },
      { identityBundleHash: core.identityBundleHash, signedBytes: core.signedBytes, sign: signer },
    );
    writeFileOnce(draftPath, `${JSON.stringify(listing, null, 2)}\n`);
  }
  console.log(JSON.stringify({ rail: action === "bootstrap" ? "bootstrapped" : "existing", draft, chainIdentity }));
}

const COMMANDS = { init, registry, "internal-keys": generateKeys, "internal-registry": registryInProject };

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const args = parseArguments(process.argv.slice(2));
    await COMMANDS[args.command](args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "unexpected failure");
    process.exitCode = 1;
  }
}
