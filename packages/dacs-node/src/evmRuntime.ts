import {
  createDacsX402BuyerEvmChallengeClient,
  createViemX402BuyerEvmReadClient,
  type DacsX402BuyerEvmChallengeClient,
  type X402BuyerEvmReadClient,
  type X402BuyerPaymentRequirements,
  type X402BuyerPreparationAuthority,
} from "@kynesyslabs/dacs";
import { signedBytes } from "@kynesyslabs/dacs/crypto";

import {
  DACS_NODE_LIVE_PROFILE,
  validateDacsAgentConfig,
} from "./config.js";
import type { DacsLoadedSecretV1 } from "./secrets.js";

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const NETWORK_RE = /^eip155:([1-9][0-9]*)$/;

export interface DacsX402BuyerEvmRuntimeOptionsV1 {
  config: unknown;
  evmPrivateKey: Readonly<DacsLoadedSecretV1>;
  rpcUrl: string;
  finalityTag?: "finalized" | "safe" | "latest";
}

export interface DacsX402BuyerEvmRuntimeV1 {
  readonly network: `eip155:${string}`;
  readonly chainId: number;
  readonly payerAddress: string;
  readonly warningCodes: readonly string[];
  readonly readClient: Readonly<X402BuyerEvmReadClient>;
  readonly destroyed: boolean;
  createChallengeClient(input: Readonly<{
    authority: Readonly<X402BuyerPreparationAuthority>;
    expectedRequirements: Readonly<X402BuyerPaymentRequirements>;
  }>): Promise<Readonly<DacsX402BuyerEvmChallengeClient>>;
  /** Sign only the DACS-1 presentation domain for the supplied bundle hash. */
  signIdentityPresentation(bundleHash: string): Promise<string>;
  destroy(): void;
}

export class DacsX402BuyerEvmRuntimeError extends Error {
  override readonly name = "DacsX402BuyerEvmRuntimeError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

export interface DacsEvmRoleIdentityV1 {
  readonly role: "buyer" | "seller";
  readonly network: `eip155:${string}`;
  readonly chainId: number;
  readonly address: string;
  readonly warningCodes: readonly string[];
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null) &&
      Reflect.ownKeys(value).every((key) => {
        if (typeof key !== "string") return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
      });
  } catch {
    return false;
  }
}

function capturePrivateKey(secret: Readonly<DacsLoadedSecretV1>): `0x${string}` {
  if (secret.destroyed) throw new DacsX402BuyerEvmRuntimeError("evm-secret-destroyed");
  let value: string;
  try {
    value = secret.text().trim();
  } catch {
    throw new DacsX402BuyerEvmRuntimeError("evm-secret-invalid");
  }
  if (!PRIVATE_KEY_RE.test(value)) {
    throw new DacsX402BuyerEvmRuntimeError("evm-secret-invalid");
  }
  return value as `0x${string}`;
}

/**
 * Derive a role's public EVM address without retaining signing authority. This
 * is the doctor/setup boundary for proving payer/payee configuration; payment
 * signing remains confined to the buyer runtime below.
 */
export async function deriveDacsEvmRoleIdentityV1(rawOptions: Readonly<{
  config: unknown;
  role: "buyer" | "seller";
  evmPrivateKey: Readonly<DacsLoadedSecretV1>;
}>): Promise<Readonly<DacsEvmRoleIdentityV1>> {
  if (!plainObject(rawOptions) ||
      (rawOptions.role !== "buyer" && rawOptions.role !== "seller") ||
      rawOptions.evmPrivateKey === null || typeof rawOptions.evmPrivateKey !== "object" ||
      typeof rawOptions.evmPrivateKey.text !== "function" ||
      typeof rawOptions.evmPrivateKey.destroy !== "function" ||
      typeof rawOptions.evmPrivateKey.destroyed !== "boolean") {
    throw new TypeError("EVM role identity options are invalid");
  }
  const config = validateDacsAgentConfig(rawOptions.config);
  if (config.mode !== "live-demos" || config.profile !== DACS_NODE_LIVE_PROFILE ||
      config.role !== rawOptions.role) {
    throw new TypeError("EVM role identity configuration is incompatible");
  }
  const match = NETWORK_RE.exec(config.rail.requestedNetwork);
  if (match === null) throw new TypeError("EVM role identity requires an eip155 network");
  const chainId = Number(match[1]);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new TypeError("EVM role identity chain is invalid");
  }
  const warnings = Object.freeze([...rawOptions.evmPrivateKey.warningCodes]);
  let privateKey: `0x${string}`;
  try {
    privateKey = capturePrivateKey(rawOptions.evmPrivateKey);
    const accounts = await import("viem/accounts").catch(() => {
      throw new DacsX402BuyerEvmRuntimeError("viem-accounts-unavailable");
    });
    const address = accounts.privateKeyToAccount(privateKey).address;
    privateKey = "" as `0x${string}`;
    return Object.freeze({
      role: rawOptions.role,
      network: config.rail.requestedNetwork as `eip155:${string}`,
      chainId,
      address,
      warningCodes: warnings,
    });
  } finally {
    privateKey = "" as `0x${string}`;
    rawOptions.evmPrivateKey.destroy();
  }
}

/**
 * Open the buyer's role-local EVM signer and canonical read client. The source
 * secret buffer is destroyed after capture; the returned runtime never exposes
 * the private key and only creates challenge clients for the exact configured
 * chain and locally derived payer address.
 */
export async function createDacsX402BuyerEvmRuntimeV1(
  rawOptions: Readonly<DacsX402BuyerEvmRuntimeOptionsV1>,
): Promise<Readonly<DacsX402BuyerEvmRuntimeV1>> {
  if (!plainObject(rawOptions) || rawOptions.evmPrivateKey === null ||
      typeof rawOptions.evmPrivateKey !== "object" ||
      typeof rawOptions.evmPrivateKey.text !== "function" ||
      typeof rawOptions.evmPrivateKey.destroy !== "function" ||
      typeof rawOptions.evmPrivateKey.destroyed !== "boolean" ||
      typeof rawOptions.rpcUrl !== "string" ||
      (rawOptions.finalityTag !== undefined &&
        !["finalized", "safe", "latest"].includes(rawOptions.finalityTag))) {
    throw new TypeError("buyer EVM runtime options are invalid");
  }
  const config = validateDacsAgentConfig(rawOptions.config);
  if (config.mode !== "live-demos" || config.profile !== DACS_NODE_LIVE_PROFILE ||
      config.role !== "buyer") {
    throw new TypeError("buyer EVM runtime requires live buyer configuration");
  }
  const match = NETWORK_RE.exec(config.rail.requestedNetwork);
  if (match === null) {
    throw new TypeError("buyer EVM runtime requires an eip155 network");
  }
  const chainId = Number(match[1]);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new TypeError("buyer EVM runtime chain is invalid");
  }

  let privateKey: `0x${string}`;
  const warnings = Object.freeze([...rawOptions.evmPrivateKey.warningCodes]);
  try {
    privateKey = capturePrivateKey(rawOptions.evmPrivateKey);
  } catch (error) {
    rawOptions.evmPrivateKey.destroy();
    throw error;
  }
  let payerAddress: string;
  let readClient: X402BuyerEvmReadClient;
  try {
    const accounts = await import("viem/accounts").catch(() => {
      throw new DacsX402BuyerEvmRuntimeError("viem-accounts-unavailable");
    });
    payerAddress = accounts.privateKeyToAccount(privateKey).address;
    readClient = await createViemX402BuyerEvmReadClient({
      rpcUrl: rawOptions.rpcUrl,
      chainId,
      ...(rawOptions.finalityTag === undefined
        ? {} : { finalityTag: rawOptions.finalityTag }),
    });
  } catch (error) {
    privateKey = "" as `0x${string}`;
    throw error;
  } finally {
    rawOptions.evmPrivateKey.destroy();
  }

  let destroyed = false;
  const network = config.rail.requestedNetwork as `eip155:${string}`;
  const runtime: DacsX402BuyerEvmRuntimeV1 = {
    network,
    chainId,
    payerAddress,
    warningCodes: warnings,
    readClient,
    get destroyed() {
      return destroyed;
    },
    async createChallengeClient(input) {
      if (destroyed || privateKey.length === 0) {
        throw new DacsX402BuyerEvmRuntimeError("evm-runtime-destroyed");
      }
      if (!plainObject(input) || !plainObject(input.authority) ||
          !plainObject(input.expectedRequirements) ||
          input.authority.network !== network ||
          input.expectedRequirements.network !== network ||
          input.authority.payer.toLowerCase() !== payerAddress.toLowerCase()) {
        throw new DacsX402BuyerEvmRuntimeError("evm-payment-authority-mismatch");
      }
      return createDacsX402BuyerEvmChallengeClient({
        evmPrivateKey: privateKey,
        authority: input.authority,
        expectedRequirements: input.expectedRequirements,
      });
    },
    async signIdentityPresentation(bundleHash) {
      if (destroyed || privateKey.length === 0) {
        throw new DacsX402BuyerEvmRuntimeError("evm-runtime-destroyed");
      }
      if (!/^[0-9a-f]{64}$/.test(bundleHash)) {
        throw new DacsX402BuyerEvmRuntimeError("evm-identity-hash-invalid");
      }
      const accounts = await import("viem/accounts").catch(() => {
        throw new DacsX402BuyerEvmRuntimeError("viem-accounts-unavailable");
      });
      const account = accounts.privateKeyToAccount(privateKey);
      if (account.address.toLowerCase() !== payerAddress.toLowerCase()) {
        throw new DacsX402BuyerEvmRuntimeError("evm-identity-authority-mismatch");
      }
      return account.signMessage({
        message: {
          raw: signedBytes("dacs-bundle-presentation:v1:", bundleHash),
        },
      });
    },
    destroy() {
      privateKey = "" as `0x${string}`;
      destroyed = true;
    },
  };
  return Object.freeze(runtime);
}
