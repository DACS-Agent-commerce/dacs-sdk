#!/usr/bin/env node
// Run script for a testnet walkthrough of a generated live project (x402 rail, local deployment).
//
// Usage. The run directory holds packs/ (three tarballs from this checkout) and an installed, built project/:
//   node scripts/fixed-price-x402-walkthrough.mjs init --run-dir <dir> --seller-url <https-url-with-a-path> --evm-rpc <https-url>
//   node scripts/fixed-price-x402-walkthrough.mjs registry --run-dir <dir> [--confirm]
//   node scripts/fixed-price-x402-walkthrough.mjs record --run-dir <dir> [--listing-ref <stor-ref>]
// Testnet only. It never sets a confirmation variable and never runs the project's setup command.
// record reads what it can observe now and marks every stage it cannot observe as unrun, with the reason.
// It makes no Demos, EVM or payment write. With --listing-ref it runs the project's buy command without
// confirmation, so the buy only checks and prints its plan; that buy's doctor can leave a transport
// diagnostic in each role's outbox, and every dacs: script rebuilds the project's dist/.
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
const MAX_NETWORK_FEE_ETH = "0.001";
const DEFAULT_DEMOS_HOST = "node2.demos.sh";
const REPLY_LIMIT_BYTES = 65_536;
const REQUEST_TIMEOUT_MS = 10_000;
const CHILD_TIMEOUT_MS = 600_000;
const CHILD_OUTPUT_LIMIT_BYTES = 1_048_576;
const AUTHORITY_RE = /^did:demos:agent:[0-9a-f]{64}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const LISTING_REF_RE = /^stor-[0-9a-f]{40}$/;
const REASON_CODE_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const CHECK_LINE_RE = /^(?:required|informational) ([a-z0-9][a-z0-9.-]*): (pass|fail|blocked)(?: \(([a-z0-9-]+)\))?(?: \[cause: [a-z0-9-]+\])?$/;
const FUNDED_REASONS = "the generated project does not start a wallet-spend authority service, " +
  "and the buyer reads the seller only over public HTTPS from a public address";

const VALUED_OPTIONS = {
  init: ["--run-dir", "--seller-url", "--evm-rpc"],
  registry: ["--run-dir"],
  record: ["--run-dir", "--listing-ref"],
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
  const missing = valued.find((name) => !values.has(name) && name !== "--listing-ref");
  if (missing !== undefined) throw new Error(`${missing} is required`);
  const evmRpc = values.get("--evm-rpc");
  if (evmRpc !== undefined && !/^https:\/\//.test(evmRpc)) throw new Error("--evm-rpc must be an HTTPS URL");
  const listingRef = values.get("--listing-ref");
  if (listingRef !== undefined && !LISTING_REF_RE.test(listingRef)) throw new Error("--listing-ref must be a storage reference: stor- and 40 lowercase hex digits");
  return { command, runDir: values.get("--run-dir"), sellerUrl: values.get("--seller-url"), evmRpc, listingRef, confirm: values.get("--confirm") === true };
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

/** Replace a JSON file atomically: write a new file with mode 0600, then rename it over the old one. */
function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

/** Replace state.json atomically. */
export function writeState(runDir, state) {
  writeJsonAtomic(join(runDir, "state.json"), state);
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
  if (url.pathname === "/") throw new Error("seller URL needs a path, such as https://host.example/seller; the seller refuses a root path");
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

/** True when something answers at the URL; a refused connection is false; a timeout is an error. */
export async function sellerServiceRunning(url, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: "error" });
    await response.body?.cancel();
    return true;
  } catch (error) {
    if (error?.cause?.code === "ECONNREFUSED") return false;
    throw error;
  }
}

/** Copy of the environment without any DACS_ variable, so only the project's .env sets them and no confirmation variable passes. */
export function childEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("DACS_")));
}

/** Parse a child's stdout: exactly one JSON object on one line. */
export function parseChildSummary(text) {
  const lines = text.split("\n").filter((line) => line !== "");
  const value = lines.length === 1 ? (() => { try { return JSON.parse(lines[0]); } catch { return undefined; } })() : undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("child summary is not one JSON object");
  return value;
}

/** Read the output of the project's buy command: the doctor text, and after a passing doctor the plan line. */
export function parseBuyOutput(text, exitCode) {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.startsWith("gate: "));
  const last = lines.findIndex((line) => line.startsWith("report: "));
  if (!lines.includes("dacs doctor") || first < 0 || last < first || lines[last + 1] !== `exit: ${exitCode}`) {
    throw new Error("buy output is not a doctor report that matches the exit code");
  }
  const notPass = lines.slice(first + 1, last).flatMap((line) => {
    const match = CHECK_LINE_RE.exec(line);
    if (match === null) throw new Error("buy output has a check line that cannot be read");
    return match[2] === "pass" ? [] : [{ id: match[1], status: match[2], ...(match[3] === undefined ? {} : { reasonCode: match[3] }) }];
  });
  const planned = lines.slice(last + 2).some((line) => { try { return JSON.parse(line)?.execute === false; } catch { return false; } });
  if (exitCode === 0 && !planned) throw new Error("buy output has no plan line after a passing doctor");
  return { notPass, planned };
}

/** Read a role service's /ready reply. A service that cannot be read is unrun, with the reason; nothing is guessed. */
export async function readReadiness(url, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: "error" });
    const { reasonCodes } = JSON.parse(await readBounded(response));
    if (!Array.isArray(reasonCodes) || !reasonCodes.every((code) => typeof code === "string" && REASON_CODE_RE.test(code))) throw new Error("unreadable");
    return { status: response.ok ? "ran" : "blocked", code: response.status, reasonCodes };
  } catch (error) {
    const connectionRefused = error?.cause?.code === "ECONNREFUSED";
    return { status: "unrun", reason: connectionRefused ? "the service did not answer (connection refused)" : "the reply of /ready could not be read" };
  }
}

const unrun = (reason) => ({ status: "unrun", reason });

/** One status per step: ran, blocked (with its reason codes or exit code) or unrun (with the reason). */
function recordSteps({ registry, readiness, buy }) {
  const roles = Object.values(readiness);
  const codes = [...new Set(roles.flatMap((role) => role.reasonCodes ?? []))];
  return {
    init: { status: "ran" },
    registry: registry === undefined ? unrun("the registry step has not saved its refs; run registry first") : { status: "ran" },
    readiness: roles.some((role) => role.status === "unrun") ? unrun("a role service was not observed")
      : roles.some((role) => role.status === "blocked") ? { status: "blocked", reasonCodes: codes } : { status: "ran" },
    // Setup is only observable through the buy: it ran when the buy exited 0, which means the buy found the Listing.
    setup: buy === undefined ? unrun("the Listing ref could not be confirmed because the buy was not run")
      : buy.exitCode === 0 ? { status: "ran", evidence: "the buy found the Listing" }
        : unrun("the Listing ref could not be confirmed because the buy did not pass"),
    buy: buy === undefined ? unrun("needs --listing-ref, the Listing ref that dacs:setup prints")
      : buy.exitCode === 0 ? { status: "ran", planOnly: true } : { status: "blocked", exitCode: buy.exitCode, notPass: buy.notPass },
    fundedPurchase: unrun(FUNDED_REASONS),
  };
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

// Run a command inside the project without any DACS_ variable; its raw output goes to logs/<name>.log.
function runLogged(run, name, command, args) {
  const result = spawnSync(command, args, {
    cwd: join(run, "project"), env: childEnvironment(process.env), encoding: "utf8", maxBuffer: CHILD_OUTPUT_LIMIT_BYTES, timeout: CHILD_TIMEOUT_MS,
  });
  writeFileSync(join(run, "logs", `${name}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`, { mode: 0o600 });
  return result;
}

// Steps that need demosdk, viem or dacs-node run this file again inside the project, with the project's loader.
// Only the child's one-line summary of public values is used.
function runChild(run, step, args) {
  const result = runLogged(run, step, process.execPath, ["--import", "@kynesyslabs/dacs-node/demos-loader", SCRIPT, `internal-${step}`, "--run-dir", run, ...args]);
  if (result.status !== 0) throw new Error(`${step} failed (${result.status ?? result.error?.code ?? result.signal}); see logs/${step}.log`);
  return parseChildSummary(result.stdout);
}

async function init({ runDir, sellerUrl, evmRpc }) {
  assertSupportedNode();
  const run = checkRunDirectory(runDir);
  checkFreshInit(run);
  const project = join(run, "project");
  if (existsSync(join(project, ".env"))) throw new Error("project/.env already exists; generate a new project, or remove the file if nothing uses it");
  if (!existsSync(join(project, "dist/src/config.js"))) throw new Error("project/ is not built; run npm run build inside project/, then init again");
  const url = normalizeSellerUrl(sellerUrl);
  buildEnvFile("", { DACS_SELLER_PUBLIC_BASE_URL: url, DACS_EVM_RPC_URL: evmRpc, DACS_BUYER_DEMOS_SECRET_FILE: join(run, "secrets") }); // values .env cannot hold fail before any key is written
  const { version } = JSON.parse(readFileSync(join(CHECKOUT, "package.json"), "utf8"));
  const tarballs = hashTarballs(run, version);
  const example = readFileSync(join(project, ".env.example"), "utf8");
  const generated = /^DACS_DEPLOYMENT=local$/m.test(example) && !example.includes("DACS_PAY_DEM_LISTING_DRAFT_FILE") &&
    /^DACS_X402_LISTING_DRAFT_FILE=\.\/listing-draft-x402\.json$/m.test(example);
  if (!generated || !existsSync(join(project, "node_modules/@kynesyslabs/dacs-node"))) {
    throw new Error("project/ must be generated with --mode live-demos --rails x402 --deploy local and installed");
  }
  for (const name of ["dacs", "dacs-node"]) if (JSON.parse(readFileSync(join(project, "node_modules/@kynesyslabs", name, "package.json"), "utf8")).version !== version) throw new Error(`installed @kynesyslabs/${name} is not version ${version}; install from packs/`);
  if (git("status", "--porcelain", "--untracked-files=no") !== "") throw new Error("the checkout has tracked changes");
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
  if (action === "bootstrap") await node.bootstrapDacsDemosX402RailRegistryV1({ runtime, resourceBaseUrl: sellerUrl, assetContract: usdc, acceptedAt });
  const rail = await core.resolveRail(core.RAIL_REGISTRY_INDEX_ADDRESS, "x402:default", provider);
  if (rail.network.resourceBaseUrl !== sellerUrl || rail.asset.contract.toLowerCase() !== usdc.toLowerCase()) {
    throw new Error("the registered rail does not match the values pinned at init");
  }
  // Always read the refs back, so a rerun after a crash before the state save still records them.
  const current = await provider.resolveCurrentIndex(core.RAIL_REGISTRY_INDEX_ADDRESS);
  const refs = { definition: (await provider.readAnchoredJson(current.indexRef)).entries[0].contentHash, index: current.indexRef.contentHash };
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

/** Read the NAME=value lines of a project file; every other line is ignored. */
function readEnvFile(run, name) {
  const file = join(run, "project", name);
  if (!existsSync(file)) throw new Error(`project/${name} is missing`);
  const lines = readFileSync(file, "utf8").split("\n").map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line));
  return Object.fromEntries(lines.filter((match) => match !== null).map(([, key, value]) => [key, value]));
}

// Observe the run as it is now and write record.json: public values and hostnames only, and every stage that
// cannot be observed as unrun with the reason. It writes no readiness record and no doctor report.
export async function record({ runDir, listingRef }, fetchImpl = fetch) {
  const run = checkRunDirectory(runDir);
  const { init, registry } = readState(run);
  if (init === undefined) throw new Error("run init first");
  const env = readEnvFile(run, ".env");
  const example = readEnvFile(run, ".env.example");
  const publicValue = (name, pattern, kind) => {
    if (!pattern.test(env[name] ?? "")) throw new Error(`${name} in project/.env is not ${kind}`);
    return env[name];
  };
  const hostname = (name) => {
    try { return new URL(env[name]).hostname; } catch { throw new Error(`${name} in project/.env is not a URL`); }
  };
  const authorities = {
    buyer: publicValue("DACS_BUYER_AUTHORITY", AUTHORITY_RE, "an authority"), seller: publicValue("DACS_SELLER_AUTHORITY", AUTHORITY_RE, "an authority"),
    steward: publicValue("DACS_RAIL_STEWARD_AUTHORITY", AUTHORITY_RE, "an authority"),
  };
  const payee = publicValue("DACS_SELLER_EVM_PAYEE", EVM_ADDRESS_RE, "an address");
  const [evmHost, demosHost] = [hostname("DACS_EVM_RPC_URL"), hostname("DACS_DEMOS_RPC_URL")];
  const tarballs = hashTarballs(run, init.packageVersion);
  for (const [name, hash] of Object.entries(init.tarballs)) {
    if (tarballs[name] !== hash) throw new Error(`tarball ${name} no longer matches the hash saved by init`);
  }
  await assertBaseSepolia(env.DACS_EVM_RPC_URL, fetchImpl);
  const readiness = {
    buyer: await readReadiness(`${env.DACS_BUYER_SERVICE_URL}/ready`, fetchImpl),
    seller: await readReadiness(`${env.DACS_SELLER_SERVICE_URL}/ready`, fetchImpl),
  };
  let buy;
  if (listingRef !== undefined) {
    const args = ["run", "dacs:buy", "--silent", "--", "--listing-ref", listingRef, "--request-file", "./request.json",
      "--max-service-amount", PRICE, "--max-network-fee-eth", MAX_NETWORK_FEE_ETH];
    const result = runLogged(run, "buy", "npm", args);
    try {
      if (result.status === null) throw new Error(`buy did not finish (${result.error?.code ?? result.signal})`);
      buy = { exitCode: result.status, ...parseBuyOutput(result.stdout, result.status) };
    } catch (error) {
      throw new Error(`${error.message}; see logs/buy.log`);
    }
  }
  const report = {
    commit: init.commit, packageVersion: init.packageVersion, tarballs: init.tarballs,
    deployment: example.DACS_DEPLOYMENT, rails: Object.hasOwn(example, "DACS_PAY_DEM_LISTING_DRAFT_FILE") ? ["x402", "pay-dem"] : ["x402"],
    network: { chain: `eip155:${CHAIN_ID}`, asset: USDC, facilitator: new URL(FACILITATOR).hostname },
    evmRpc: { host: evmHost },
    demosRpc: demosHost === DEFAULT_DEMOS_HOST ? { host: demosHost } : { host: "custom", chainIdentity: registry?.chainIdentity },
    authorities, payee, registry: registry?.refs, listingRef, readiness,
    steps: recordSteps({ registry, readiness, buy }),
    fundedRun: `Funded run: UNRUN — ${FUNDED_REASONS}`,
  };
  writeJsonAtomic(join(run, "record.json"), report);
  console.log(JSON.stringify(report));
  return report;
}

const COMMANDS = { init, registry, record, "internal-keys": generateKeys, "internal-registry": registryInProject };

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const args = parseArguments(process.argv.slice(2));
    await COMMANDS[args.command](args);
  } catch (error) {
    console.error(error instanceof Error ? [error.message, error.cause?.message].filter(Boolean).join(": ") : "unexpected failure");
    process.exitCode = 1;
  }
}
