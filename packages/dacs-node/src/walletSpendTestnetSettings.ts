import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { captureWalletSpendPolicyV1, type WalletSpendPolicyV1 } from "@kynesyslabs/dacs";

import { loadDacsSecretV1 } from "./secrets.js";
import {
  createDacsWalletSpendContinuitySignerV1,
  dacsWalletSpendPolicyHashV1,
} from "./walletSpendPostgres.js";

/** The x402 lane's one network: Base Sepolia. No setting changes it. */
export const DACS_WALLET_SPEND_TESTNET_CHAIN_ID = "eip155:84532";

/** The DEM lane's one network: the Demos testnet, checked at start against the approved identity. */
export const DACS_WALLET_SPEND_TESTNET_DEMOS_CHAIN_ID = "demos";

/** The settings both lanes share, always required, in the order a missing one is reported. */
export const DACS_WALLET_SPEND_TESTNET_AUTHORITY_COMMON_SETTING_NAMES: readonly string[] = Object.freeze([
  "DACS_WALLET_AUTHORITY_URL",
  "DACS_BUYER_WALLET_AUTHORITY_TOKEN_FILE",
  "DACS_WALLET_AUTHORITY_ID",
  "DACS_WALLET_AUTHORITY_EPOCH",
  "DACS_WALLET_AUTHORITY_WITNESS_PUBLIC_KEY",
  "DACS_WALLET_AUTHORITY_WITNESS_SEED_FILE",
]);

const X402_DATA_SETTING = "DACS_WALLET_AUTHORITY_DATA_DIRECTORY";
const POLICY_SETTING = "DACS_WALLET_AUTHORITY_POLICY_FILE";
const X402_SETTING_NAMES = Object.freeze([
  X402_DATA_SETTING, POLICY_SETTING, "DACS_EVM_RPC_URL", "DACS_X402_AUTHORIZATION_SEARCH_FROM_BLOCK",
]);

/** The common settings and the x402 lane's four, in the order a missing one is reported. */
export const DACS_WALLET_SPEND_TESTNET_AUTHORITY_SETTING_NAMES: readonly string[] = Object.freeze([
  ...DACS_WALLET_SPEND_TESTNET_AUTHORITY_COMMON_SETTING_NAMES,
  ...X402_SETTING_NAMES,
]);

const DEM_DATA_SETTING = "DACS_PAY_DEM_WALLET_AUTHORITY_DATA_DIRECTORY";
const DEM_POLICY_SETTING = "DACS_PAY_DEM_WALLET_AUTHORITY_POLICY_FILE";
const DEMOS_RPC_SETTING = "DACS_DEMOS_RPC_URL";

/** The DEM lane's settings, in the order a missing one is reported. */
export const DACS_WALLET_SPEND_TESTNET_AUTHORITY_PAY_DEM_SETTING_NAMES: readonly string[] = Object.freeze([
  DEM_DATA_SETTING, DEM_POLICY_SETTING, DEMOS_RPC_SETTING,
]);

const TOKEN_SETTING = "DACS_BUYER_WALLET_AUTHORITY_TOKEN_FILE";
const SEED_SETTING = "DACS_WALLET_AUTHORITY_WITNESS_SEED_FILE";
const DEM_ASSET = "DEM";
const MAX_POLICY_FILE_BYTES = 64 * 1024;
const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 4_096;
const SEED_HEX_RE = /^[0-9a-fA-F]{64}$/;
const VERIFICATION_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const DEMOS_ADDRESS_RE = /^0x[0-9a-f]{64}$/;
const BLOCK_NUMBER_RE = /^(0|[1-9][0-9]*)$/;

/** A refused testnet authority setting: `reasonCode` says why, `setting` names the setting at fault. */
export class DacsWalletSpendTestnetAuthorityError extends Error {
  override readonly name = "DacsWalletSpendTestnetAuthorityError";

  constructor(readonly reasonCode: string, readonly setting?: string, options?: { cause?: unknown }) {
    super(reasonCode, options);
  }
}

/**
 * The checked public settings of the testnet authority. It holds no secret.
 * At least one of `x402` (Base Sepolia) and `payDem` (Demos testnet) is present.
 */
export interface DacsWalletSpendTestnetAuthoritySettingsV1 {
  listen: Readonly<{ hostname: string; port: number }>;
  authorityId: string;
  epoch: string;
  witnessVerificationKey: string;
  x402?: Readonly<{
    dataDirectory: string;
    evmRpcUrl: string;
    authorizationSearchFromBlock: number;
    policy: Readonly<WalletSpendPolicyV1>;
    policyHash: string;
  }>;
  payDem?: Readonly<{
    dataDirectory: string;
    demosRpcUrl: string;
    policy: Readonly<WalletSpendPolicyV1>;
    policyHash: string;
  }>;
}

type Environment = Readonly<Record<string, string | undefined>>;

const refuse = (reasonCode: string, setting?: string, cause?: unknown): never => {
  throw new DacsWalletSpendTestnetAuthorityError(
    `wallet-spend-testnet-authority-${reasonCode}`,
    setting,
    cause === undefined ? undefined : { cause },
  );
};

function required(environment: Environment, name: string): string {
  const value = environment[name];
  return value === undefined || value.trim() === "" ? refuse("setting-missing", name) : value;
}

const isSet = (environment: Environment, name: string): boolean => (environment[name] ?? "").trim() !== "";

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function parsedUrl(value: string, reasonCode: string, setting: string): URL {
  try {
    return new URL(value);
  } catch {
    return refuse(reasonCode, setting);
  }
}

/** Plain http on a loopback host with an explicit port and nothing after the root path. */
function listenAddress(value: string): Readonly<{ hostname: string; port: number }> {
  const url = parsedUrl(value, "url-refused", "DACS_WALLET_AUTHORITY_URL");
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname) || url.port === "" ||
      url.pathname !== "/" || url.search !== "" || url.hash !== "" ||
      url.username !== "" || url.password !== "") {
    refuse("url-refused", "DACS_WALLET_AUTHORITY_URL");
  }
  const hostname = url.hostname === "[::1]" ? "::1" : url.hostname;
  return Object.freeze({ hostname, port: Number(url.port) });
}

/** An https node address, or plain http on a loopback host, without a user or password. */
function rpcUrl(value: string, reasonCode: string, setting: string): string {
  const url = parsedUrl(value, reasonCode, setting);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname))) ||
      url.username !== "" || url.password !== "") {
    refuse(reasonCode, setting);
  }
  return value;
}

/** A data directory path, resolved; not opened here. */
function dataDirectoryPath(value: string, setting: string): string {
  return value.includes("\0") ? refuse("setting-invalid", setting) : resolve(value);
}

/** True when `inner` is `outer` or lies inside it. */
function isWithin(outer: string, inner: string): boolean {
  const path = relative(outer, inner);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function exactIdentity(value: string, setting: string): string {
  return value.trim() !== value || value.normalize("NFC") !== value
    ? refuse("setting-invalid", setting)
    : value;
}

function searchFloor(value: string): number {
  const block = Number(value);
  return BLOCK_NUMBER_RE.test(value) && Number.isSafeInteger(block)
    ? block
    : refuse("setting-invalid", "DACS_X402_AUTHORIZATION_SEARCH_FROM_BLOCK");
}

async function secretText(path: string, name: string): Promise<string> {
  const secret = await loadDacsSecretV1({ name, mode: "live-demos", filePath: resolve(path) });
  try {
    return secret.text().trim();
  } finally {
    secret.destroy();
  }
}

/** Reads the bearer token file and returns only the SHA-256 digest of the trimmed token. */
async function loadToken(path: string): Promise<Uint8Array> {
  let token: string;
  try {
    token = await secretText(path, "wallet-spend-authority-token");
  } catch (error) {
    return refuse("token-invalid", TOKEN_SETTING, error);
  }
  if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH || /[\0\r\n]/.test(token)) {
    refuse("token-invalid", TOKEN_SETTING);
  }
  return Uint8Array.from(createHash("sha256").update(token, "utf8").digest());
}

/** Reads a private file holding 64 hex characters and returns the 32 seed bytes. */
async function loadSeed(path: string): Promise<Uint8Array> {
  let text: string;
  try {
    text = await secretText(path, "wallet-spend-authority-witness-seed");
  } catch (error) {
    return refuse("witness-seed-invalid", SEED_SETTING, error);
  }
  if (!SEED_HEX_RE.test(text)) refuse("witness-seed-invalid", SEED_SETTING);
  const decoded = Buffer.from(text, "hex");
  const seed = Uint8Array.from(decoded);
  decoded.fill(0);
  return seed;
}

async function readPolicyText(path: string): Promise<string> {
  const handle = await open(resolve(path), "r");
  try {
    if ((await handle.stat()).size > MAX_POLICY_FILE_BYTES) throw new Error("policy-file-too-large");
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_POLICY_FILE_BYTES) throw new Error("policy-file-too-large");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    await handle.close();
  }
}

/**
 * Reads one policy file for one lane: its `chainId` must be exactly `chainId`, its wallet must match
 * `walletPattern`, and it must have exactly one asset that `isAsset` accepts.
 */
async function loadPolicy(path: string, setting: string, lane: Readonly<{
  chainId: string;
  walletPattern: RegExp;
  isAsset(asset: string): boolean;
}>): Promise<Readonly<WalletSpendPolicyV1>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readPolicyText(path));
  } catch (error) {
    return refuse("policy-unreadable", setting, error);
  }
  let policy: Readonly<WalletSpendPolicyV1>;
  try {
    policy = captureWalletSpendPolicyV1(parsed as WalletSpendPolicyV1);
  } catch (error) {
    return refuse("policy-invalid", setting, error);
  }
  if (policy.chainId !== lane.chainId) refuse("network-refused", setting);
  const [asset, ...others] = policy.assets;
  if (asset === undefined || others.length > 0 || !lane.isAsset(asset.asset) || !lane.walletPattern.test(policy.wallet)) {
    refuse("policy-invalid", setting);
  }
  return policy;
}

const X402_POLICY_RULE = Object.freeze({
  chainId: DACS_WALLET_SPEND_TESTNET_CHAIN_ID,
  walletPattern: EVM_ADDRESS_RE,
  isAsset: (asset: string) => EVM_ADDRESS_RE.test(asset),
});

const DEM_POLICY_RULE = Object.freeze({
  chainId: DACS_WALLET_SPEND_TESTNET_DEMOS_CHAIN_ID,
  walletPattern: DEMOS_ADDRESS_RE,
  isAsset: (asset: string) => asset === DEM_ASSET,
});

type X402LaneSettings = NonNullable<DacsWalletSpendTestnetAuthoritySettingsV1["x402"]>;
type PayDemLaneSettings = NonNullable<DacsWalletSpendTestnetAuthoritySettingsV1["payDem"]>;

async function loadX402Lane(environment: Environment): Promise<X402LaneSettings> {
  const lane = {
    dataDirectory: dataDirectoryPath(required(environment, X402_DATA_SETTING), X402_DATA_SETTING),
    evmRpcUrl: rpcUrl(required(environment, "DACS_EVM_RPC_URL"), "rpc-url-refused", "DACS_EVM_RPC_URL"),
    authorizationSearchFromBlock: searchFloor(required(environment, "DACS_X402_AUTHORIZATION_SEARCH_FROM_BLOCK")),
  };
  const policy = await loadPolicy(required(environment, POLICY_SETTING), POLICY_SETTING, X402_POLICY_RULE);
  return Object.freeze({ ...lane, policy, policyHash: dacsWalletSpendPolicyHashV1(policy) });
}

async function loadPayDemLane(
  environment: Environment,
  x402DataDirectory: string | undefined,
): Promise<PayDemLaneSettings> {
  const dataDirectory = dataDirectoryPath(required(environment, DEM_DATA_SETTING), DEM_DATA_SETTING);
  // Each lane has its own witness and states: neither directory may hold the other.
  if (x402DataDirectory !== undefined &&
      (isWithin(x402DataDirectory, dataDirectory) || isWithin(dataDirectory, x402DataDirectory))) {
    refuse("setting-invalid", DEM_DATA_SETTING);
  }
  const demosRpcUrl = rpcUrl(required(environment, DEMOS_RPC_SETTING), "demos-rpc-url-refused", DEMOS_RPC_SETTING);
  const policy = await loadPolicy(required(environment, DEM_POLICY_SETTING), DEM_POLICY_SETTING, DEM_POLICY_RULE);
  return Object.freeze({ dataDirectory, demosRpcUrl, policy, policyHash: dacsWalletSpendPolicyHashV1(policy) });
}

/** Derives the witness public key and zeroes the seed when it differs from the pinned key. */
function assertWitnessKey(seed: Uint8Array, pinned: string): void {
  if (createDacsWalletSpendContinuitySignerV1({ seed }).verificationKey !== pinned) {
    seed.fill(0);
    refuse("witness-key-mismatch", SEED_SETTING);
  }
}

/**
 * Reads and checks the testnet wallet-spend authority's settings: the common
 * ones and those of each configured lane (x402 on Base Sepolia, DEM on the
 * Demos testnet). It opens no socket and creates no file. The bearer token
 * leaves only as its SHA-256 digest; the caller zeroes `witnessSeed` once the
 * stores are open.
 *
 * @param environment The settings source; `process.env` when omitted.
 * @returns The public settings, the token digest and the 32-byte witness seed.
 * @throws DacsWalletSpendTestnetAuthorityError naming the refused setting, or
 *   `wallet-spend-testnet-authority-network-missing` when no lane is configured.
 */
export async function loadDacsWalletSpendTestnetAuthoritySettingsV1(
  environment: Environment = process.env,
): Promise<Readonly<{
  settings: Readonly<DacsWalletSpendTestnetAuthoritySettingsV1>;
  tokenDigest: Uint8Array;
  witnessSeed: Uint8Array;
}>> {
  for (const name of DACS_WALLET_SPEND_TESTNET_AUTHORITY_COMMON_SETTING_NAMES) required(environment, name);
  // A lane is configured when its own data directory or policy file is set; it then needs all its settings.
  const x402Configured = isSet(environment, X402_DATA_SETTING) || isSet(environment, POLICY_SETTING);
  const payDemConfigured = isSet(environment, DEM_DATA_SETTING) || isSet(environment, DEM_POLICY_SETTING);
  if (!x402Configured && !payDemConfigured) refuse("network-missing");
  if (x402Configured) for (const name of X402_SETTING_NAMES) required(environment, name);
  if (payDemConfigured) {
    for (const name of DACS_WALLET_SPEND_TESTNET_AUTHORITY_PAY_DEM_SETTING_NAMES) required(environment, name);
  }
  const setting = (name: string): string => required(environment, name);
  const verificationKey = setting("DACS_WALLET_AUTHORITY_WITNESS_PUBLIC_KEY");
  if (!VERIFICATION_KEY_RE.test(verificationKey)) {
    refuse("setting-invalid", "DACS_WALLET_AUTHORITY_WITNESS_PUBLIC_KEY");
  }
  const common = {
    listen: listenAddress(setting("DACS_WALLET_AUTHORITY_URL")),
    authorityId: exactIdentity(setting("DACS_WALLET_AUTHORITY_ID"), "DACS_WALLET_AUTHORITY_ID"),
    epoch: exactIdentity(setting("DACS_WALLET_AUTHORITY_EPOCH"), "DACS_WALLET_AUTHORITY_EPOCH"),
    witnessVerificationKey: verificationKey,
  };
  const x402 = x402Configured ? await loadX402Lane(environment) : undefined;
  const payDem = payDemConfigured ? await loadPayDemLane(environment, x402?.dataDirectory) : undefined;
  const tokenDigest = await loadToken(setting(TOKEN_SETTING));
  const witnessSeed = await loadSeed(setting(SEED_SETTING));
  assertWitnessKey(witnessSeed, verificationKey);
  return Object.freeze({
    settings: Object.freeze({
      ...common,
      ...(x402 === undefined ? {} : { x402 }),
      ...(payDem === undefined ? {} : { payDem }),
    }),
    tokenDigest,
    witnessSeed,
  });
}

/**
 * Returns the base64url public key for a witness seed file, so an operator can
 * fill `DACS_WALLET_AUTHORITY_WITNESS_PUBLIC_KEY`. It prints nothing.
 *
 * @throws DacsWalletSpendTestnetAuthorityError `wallet-spend-testnet-authority-witness-seed-invalid`.
 */
export async function dacsWalletSpendTestnetWitnessPublicKeyV1(seedFilePath: string): Promise<string> {
  const seed = await loadSeed(seedFilePath);
  try {
    return createDacsWalletSpendContinuitySignerV1({ seed }).verificationKey;
  } finally {
    seed.fill(0);
  }
}
