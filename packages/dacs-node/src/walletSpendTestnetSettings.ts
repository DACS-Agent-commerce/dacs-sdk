import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

import { captureWalletSpendPolicyV1, type WalletSpendPolicyV1 } from "@kynesyslabs/dacs";

import { loadDacsSecretV1 } from "./secrets.js";
import {
  createDacsWalletSpendContinuitySignerV1,
  dacsWalletSpendPolicyHashV1,
} from "./walletSpendPostgres.js";

/** The one network the testnet authority serves: Base Sepolia. No setting changes it. */
export const DACS_WALLET_SPEND_TESTNET_CHAIN_ID = "eip155:84532";

/** The settings the testnet authority reads, in the order a missing one is reported. */
export const DACS_WALLET_SPEND_TESTNET_AUTHORITY_SETTING_NAMES: readonly string[] = Object.freeze([
  "DACS_WALLET_AUTHORITY_URL",
  "DACS_BUYER_WALLET_AUTHORITY_TOKEN_FILE",
  "DACS_WALLET_AUTHORITY_ID",
  "DACS_WALLET_AUTHORITY_EPOCH",
  "DACS_WALLET_AUTHORITY_WITNESS_PUBLIC_KEY",
  "DACS_WALLET_AUTHORITY_WITNESS_SEED_FILE",
  "DACS_WALLET_AUTHORITY_DATA_DIRECTORY",
  "DACS_WALLET_AUTHORITY_POLICY_FILE",
  "DACS_EVM_RPC_URL",
  "DACS_X402_AUTHORIZATION_SEARCH_FROM_BLOCK",
]);

const TOKEN_SETTING = "DACS_BUYER_WALLET_AUTHORITY_TOKEN_FILE";
const SEED_SETTING = "DACS_WALLET_AUTHORITY_WITNESS_SEED_FILE";
const POLICY_SETTING = "DACS_WALLET_AUTHORITY_POLICY_FILE";
const MAX_POLICY_FILE_BYTES = 64 * 1024;
const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 4_096;
const SEED_HEX_RE = /^[0-9a-fA-F]{64}$/;
const VERIFICATION_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const BLOCK_NUMBER_RE = /^(0|[1-9][0-9]*)$/;

/** A refused testnet authority setting: `reasonCode` says why, `setting` names the setting at fault. */
export class DacsWalletSpendTestnetAuthorityError extends Error {
  override readonly name = "DacsWalletSpendTestnetAuthorityError";

  constructor(readonly reasonCode: string, readonly setting?: string, options?: { cause?: unknown }) {
    super(reasonCode, options);
  }
}

/** The checked public settings of the testnet authority. It holds no secret. */
export interface DacsWalletSpendTestnetAuthoritySettingsV1 {
  listen: Readonly<{ hostname: string; port: number }>;
  authorityId: string;
  epoch: string;
  witnessVerificationKey: string;
  dataDirectory: string;
  evmRpcUrl: string;
  authorizationSearchFromBlock: number;
  policy: Readonly<WalletSpendPolicyV1>;
  policyHash: string;
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
  // URL normalizes an explicit :80 away. Recover it only from the raw authority.
  const authority = /^http:\/\/([^/\\?#]*)/i.exec(value.trim())?.[1] ?? "";
  const port = Number(url.port || /:([0-9]+)$/.exec(authority)?.[1]);
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname) ||
      !Number.isInteger(port) ||
      url.pathname !== "/" || url.search !== "" || url.hash !== "" ||
      url.username !== "" || url.password !== "") {
    refuse("url-refused", "DACS_WALLET_AUTHORITY_URL");
  }
  const hostname = url.hostname === "[::1]" ? "::1" : url.hostname;
  return Object.freeze({ hostname, port });
}

function rpcUrl(value: string): string {
  const url = parsedUrl(value, "rpc-url-refused", "DACS_EVM_RPC_URL");
  if (!(url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname))) ||
      url.username !== "" || url.password !== "") {
    refuse("rpc-url-refused", "DACS_EVM_RPC_URL");
  }
  return value;
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

/** Reads one policy for one Base Sepolia wallet and one ERC-20 asset. */
async function loadPolicy(path: string): Promise<Readonly<WalletSpendPolicyV1>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readPolicyText(path));
  } catch (error) {
    return refuse("policy-unreadable", POLICY_SETTING, error);
  }
  let policy: Readonly<WalletSpendPolicyV1>;
  try {
    policy = captureWalletSpendPolicyV1(parsed as WalletSpendPolicyV1);
  } catch (error) {
    return refuse("policy-invalid", POLICY_SETTING, error);
  }
  if (policy.chainId !== DACS_WALLET_SPEND_TESTNET_CHAIN_ID) refuse("network-refused", POLICY_SETTING);
  const [asset, ...others] = policy.assets;
  if (asset === undefined || others.length > 0 || !EVM_ADDRESS_RE.test(asset.asset) ||
      !EVM_ADDRESS_RE.test(policy.wallet)) {
    refuse("policy-invalid", POLICY_SETTING);
  }
  return policy;
}

/** Derives the witness public key and zeroes the seed when it differs from the pinned key. */
function assertWitnessKey(seed: Uint8Array, pinned: string): void {
  if (createDacsWalletSpendContinuitySignerV1({ seed }).verificationKey !== pinned) {
    seed.fill(0);
    refuse("witness-key-mismatch", SEED_SETTING);
  }
}

/**
 * Reads and checks the testnet wallet-spend authority's settings. It opens no
 * socket and creates no file. The bearer token leaves only as its SHA-256
 * digest; the caller zeroes `witnessSeed` once the stores are open.
 *
 * @param environment The settings source; `process.env` when omitted.
 * @returns The public settings, the token digest and the 32-byte witness seed.
 * @throws DacsWalletSpendTestnetAuthorityError naming the refused setting.
 */
export async function loadDacsWalletSpendTestnetAuthoritySettingsV1(
  environment: Environment = process.env,
): Promise<Readonly<{
  settings: Readonly<DacsWalletSpendTestnetAuthoritySettingsV1>;
  tokenDigest: Uint8Array;
  witnessSeed: Uint8Array;
}>> {
  for (const name of DACS_WALLET_SPEND_TESTNET_AUTHORITY_SETTING_NAMES) required(environment, name);
  const setting = (name: string): string => required(environment, name);
  const verificationKey = setting("DACS_WALLET_AUTHORITY_WITNESS_PUBLIC_KEY");
  if (!VERIFICATION_KEY_RE.test(verificationKey)) {
    refuse("setting-invalid", "DACS_WALLET_AUTHORITY_WITNESS_PUBLIC_KEY");
  }
  const dataDirectory = setting("DACS_WALLET_AUTHORITY_DATA_DIRECTORY");
  if (dataDirectory.includes("\0")) refuse("setting-invalid", "DACS_WALLET_AUTHORITY_DATA_DIRECTORY");
  const settings = {
    listen: listenAddress(setting("DACS_WALLET_AUTHORITY_URL")),
    authorityId: exactIdentity(setting("DACS_WALLET_AUTHORITY_ID"), "DACS_WALLET_AUTHORITY_ID"),
    epoch: exactIdentity(setting("DACS_WALLET_AUTHORITY_EPOCH"), "DACS_WALLET_AUTHORITY_EPOCH"),
    witnessVerificationKey: verificationKey,
    dataDirectory: resolve(dataDirectory),
    evmRpcUrl: rpcUrl(setting("DACS_EVM_RPC_URL")),
    authorizationSearchFromBlock: searchFloor(setting("DACS_X402_AUTHORIZATION_SEARCH_FROM_BLOCK")),
  };
  const policy = await loadPolicy(setting(POLICY_SETTING));
  const tokenDigest = await loadToken(setting(TOKEN_SETTING));
  const witnessSeed = await loadSeed(setting(SEED_SETTING));
  assertWitnessKey(witnessSeed, verificationKey);
  return Object.freeze({
    settings: Object.freeze({ ...settings, policy, policyHash: dacsWalletSpendPolicyHashV1(policy) }),
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
