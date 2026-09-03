import { types as nodeTypes } from "node:util";

import type {
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";

import { canonicalize, sha256Hex } from "../canonical/index.js";
import { CounterpartyError } from "../errors.js";
import type {
  X402BuyerJson,
  X402BuyerPaymentRequirements,
} from "./x402BuyerSettlement.js";
import {
  captureX402BuyerPreparationAuthority,
  type X402BuyerChallengeClient,
  type X402BuyerPreparationAuthority,
} from "./x402BuyerTransport.js";

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const NETWORK_RE = /^eip155:([1-9][0-9]*)$/;
const AMOUNT_RE = /^[1-9][0-9]*$/;
const REQUIREMENT_KEYS = [
  "scheme",
  "network",
  "amount",
  "asset",
  "payTo",
  "maxTimeoutSeconds",
  "extra",
] as const;

export interface DacsX402BuyerEvmChallengeClientConfig {
  /** Buyer EVM key. It remains captured inside the local signing client. */
  evmPrivateKey: string;
  /** The authenticated DACS authority also supplied to preparation. */
  authority: Readonly<X402BuyerPreparationAuthority>;
  /**
   * Exact authenticated x402 requirement, including timeout and EIP-712
   * `extra.name` / `extra.version`. Challenge additions or substitutions fail.
   */
  expectedRequirements: Readonly<X402BuyerPaymentRequirements>;
}

export interface DacsX402BuyerEvmChallengeClient
  extends X402BuyerChallengeClient {
  /** Checksummed address derived locally from the configured key. */
  readonly address: string;
  /** Normative DACS SB-3 EIP-3009 nonce retained by every signing call. */
  readonly authorizationNonce: `0x${string}`;
}

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function deepFreezeJson(value: X402BuyerJson): X402BuyerJson {
  if (value !== null && typeof value === "object") {
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
      deepFreezeJson(item);
    }
    Object.freeze(value);
  }
  return value;
}

function captureJson(
  value: unknown,
  ancestors = new Set<object>(),
  depth = 0,
): X402BuyerJson | null {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return hasOnlyUnicodeScalars(value) ? value : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
      && !Object.is(value, -0)
      ? value
      : null;
  }
  if (typeof value !== "object" || depth >= 64 || nodeTypes.isProxy(value)) {
    return null;
  }
  if (ancestors.has(value)) return null;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype ||
          Reflect.ownKeys(value).length !== value.length + 1) return null;
      const copy: X402BuyerJson[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
        const item = captureJson(descriptor.value, ancestors, depth + 1);
        if (item === null && descriptor.value !== null) return null;
        copy.push(item);
      }
      return deepFreezeJson(copy);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return null;
    const copy: Record<string, X402BuyerJson> = {};
    for (const key of keys as string[]) {
      if (!hasOnlyUnicodeScalars(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor) ||
          descriptor.value === undefined) return null;
      const item = captureJson(descriptor.value, ancestors, depth + 1);
      if (item === null && descriptor.value !== null) return null;
      copy[key] = item;
    }
    // Enforce the same canonical-domain constraints the durable intent uses,
    // while retaining the original string bytes for EIP-712 equality below.
    canonicalize(copy);
    return deepFreezeJson(copy);
  } catch {
    return null;
  } finally {
    ancestors.delete(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function captureRequirements(
  value: unknown,
): Readonly<X402BuyerPaymentRequirements> | null {
  if (!isRecord(value) || nodeTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== REQUIREMENT_KEYS.length ||
      REQUIREMENT_KEYS.some((key) => {
        const descriptor = descriptors[key];
        return !descriptor || !descriptor.enumerable || !("value" in descriptor) ||
          descriptor.value === undefined;
      })) return null;
  const read = (key: typeof REQUIREMENT_KEYS[number]): unknown =>
    descriptors[key]!.value;
  const network = read("network");
  const chainMatch = typeof network === "string" ? NETWORK_RE.exec(network) : null;
  const extra = captureJson(read("extra"));
  if (read("scheme") !== "exact" || !chainMatch ||
      !Number.isSafeInteger(Number(chainMatch[1])) ||
      typeof read("amount") !== "string" || !AMOUNT_RE.test(read("amount") as string) ||
      typeof read("asset") !== "string" || !ADDRESS_RE.test(read("asset") as string) ||
      typeof read("payTo") !== "string" || !ADDRESS_RE.test(read("payTo") as string) ||
      !Number.isSafeInteger(read("maxTimeoutSeconds")) ||
      Number(read("maxTimeoutSeconds")) <= 0 ||
      !isRecord(extra) || Array.isArray(extra)) return null;
  const domainName = extra.name;
  const domainVersion = extra.version;
  if (typeof domainName !== "string" || domainName.length === 0 ||
      typeof domainVersion !== "string" || domainVersion.length === 0 ||
      (extra.assetTransferMethod !== undefined &&
        extra.assetTransferMethod !== "eip3009")) return null;
  return Object.freeze({
    scheme: "exact",
    network: network as `eip155:${string}`,
    amount: read("amount") as string,
    asset: read("asset") as string,
    payTo: read("payTo") as string,
    maxTimeoutSeconds: read("maxTimeoutSeconds") as number,
    extra: extra as Readonly<Record<string, X402BuyerJson>>,
  });
}

function sameJson(left: X402BuyerJson, right: X402BuyerJson): boolean {
  if (left === null || right === null || typeof left !== "object" ||
      typeof right !== "object") return Object.is(left, right);
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJson(item, right[index]!));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] &&
      sameJson(left[key]!, right[key]!));
}

function requirementsMatch(
  candidate: unknown,
  expected: Readonly<X402BuyerPaymentRequirements>,
): boolean {
  const captured = captureRequirements(candidate);
  return captured !== null && captured.scheme === expected.scheme &&
    captured.network === expected.network && captured.amount === expected.amount &&
    captured.asset.toLowerCase() === expected.asset.toLowerCase() &&
    captured.payTo.toLowerCase() === expected.payTo.toLowerCase() &&
    captured.maxTimeoutSeconds === expected.maxTimeoutSeconds &&
    sameJson(
      captured.extra as Record<string, X402BuyerJson>,
      expected.extra as Record<string, X402BuyerJson>,
    );
}

function assertExpectedRequirements(
  value: unknown,
  authority: Readonly<X402BuyerPreparationAuthority>,
): Readonly<X402BuyerPaymentRequirements> {
  const requirements = captureRequirements(value);
  if (!requirements || requirements.network !== authority.network ||
      requirements.amount !== authority.amount ||
      requirements.asset.toLowerCase() !== authority.asset.toLowerCase() ||
      requirements.payTo.toLowerCase() !== authority.payee.toLowerCase()) {
    throw new TypeError(
      "DACS x402 expected requirements must exactly match the authenticated authority",
    );
  }
  return requirements;
}

function captureChallengeClientConfig(
  value: unknown,
): Readonly<{
  evmPrivateKey: `0x${string}`;
  authority: Readonly<X402BuyerPreparationAuthority>;
  expectedRequirements: Readonly<X402BuyerPaymentRequirements>;
}> {
  const keys = ["evmPrivateKey", "authority", "expectedRequirements"] as const;
  if (!isRecord(value) || nodeTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError("DACS x402 buyer config must be a plain data record");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== keys.length ||
      keys.some((key) => {
        const descriptor = descriptors[key];
        return !descriptor || !descriptor.enumerable || !("value" in descriptor) ||
          descriptor.value === undefined;
      })) {
    throw new TypeError("DACS x402 buyer config must contain only own data properties");
  }
  const evmPrivateKey = descriptors.evmPrivateKey!.value;
  if (typeof evmPrivateKey !== "string" || !PRIVATE_KEY_RE.test(evmPrivateKey)) {
    throw new TypeError("DACS x402 buyer requires a 32-byte EVM private key");
  }
  const authority = captureX402BuyerPreparationAuthority(
    descriptors.authority!.value,
  );
  if (!authority) throw new TypeError("DACS x402 buyer authority is invalid");
  const expectedRequirements = assertExpectedRequirements(
    descriptors.expectedRequirements!.value,
    authority,
  );
  return Object.freeze({
    evmPrivateKey: evmPrivateKey as `0x${string}`,
    authority,
    expectedRequirements,
  });
}

function dacsNonce(jobId: string, phaseIndex: number): `0x${string}` {
  return `0x${sha256Hex(
    `dacs-sb3:v1:${jobId.normalize("NFC")}:${phaseIndex}`,
  )}`;
}

/**
 * Build the real x402 v2 HTTP/core client used by durable buyer preparation,
 * replacing only ExactEvmScheme's random EIP-3009 nonce with DACS SB-3's
 * deterministic session nonce. This client can sign, but has no submit path.
 */
export async function createDacsX402BuyerEvmChallengeClient(
  config: Readonly<DacsX402BuyerEvmChallengeClientConfig>,
): Promise<Readonly<DacsX402BuyerEvmChallengeClient>> {
  const captured = captureChallengeClientConfig(config);
  const evmPrivateKey = captured.evmPrivateKey;
  const authority = captured.authority;
  const expected = captured.expectedRequirements;

  const core = await import("@x402/core/client").catch((cause: unknown) => {
    throw new CounterpartyError(
      "createDacsX402BuyerEvmChallengeClient requires the optional peer @x402/core",
      { cause },
    );
  });
  const evm = await import("@x402/evm").catch((cause: unknown) => {
    throw new CounterpartyError(
      "createDacsX402BuyerEvmChallengeClient requires the optional peer @x402/evm",
      { cause },
    );
  });
  const accounts = await import("viem/accounts").catch((cause: unknown) => {
    throw new CounterpartyError(
      "createDacsX402BuyerEvmChallengeClient requires the optional peer viem",
      { cause },
    );
  });
  const viem = await import("viem").catch((cause: unknown) => {
    throw new CounterpartyError(
      "createDacsX402BuyerEvmChallengeClient requires the optional peer viem",
      { cause },
    );
  });

  const account = accounts.privateKeyToAccount(evmPrivateKey);
  if (account.address.toLowerCase() !== authority.payer.toLowerCase()) {
    throw new TypeError("DACS x402 buyer key does not control the authenticated payer");
  }
  const nonce = dacsNonce(authority.jobId, authority.phaseIndex);
  const chainId = Number(authority.network.slice("eip155:".length));

  const scheme: SchemeNetworkClient = {
    scheme: "exact",
    async createPaymentPayload(
      version: number,
      requirements: PaymentRequirements,
    ): Promise<PaymentPayloadResult> {
      if (version !== 2 || !requirementsMatch(requirements, expected)) {
        throw new CounterpartyError(
          "x402 challenge requirements do not match DACS signing authority",
        );
      }
      const now = Math.floor(Date.now() / 1_000);
      const validBefore = now + expected.maxTimeoutSeconds;
      if (!Number.isSafeInteger(now) || now < 0 ||
          !Number.isSafeInteger(validBefore)) {
        throw new TypeError("DACS x402 authorization clock is outside the supported range");
      }
      const authorization = {
        from: account.address,
        to: viem.getAddress(expected.payTo),
        value: expected.amount,
        validAfter: "0",
        validBefore: String(validBefore),
        nonce,
      };
      const signature = await account.signTypedData({
        domain: {
          name: expected.extra.name as string,
          version: expected.extra.version as string,
          chainId,
          verifyingContract: viem.getAddress(expected.asset),
        },
        types: evm.authorizationTypes,
        primaryType: "TransferWithAuthorization",
        message: {
          from: viem.getAddress(authorization.from),
          to: viem.getAddress(authorization.to),
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
          nonce: authorization.nonce,
        },
      });
      return {
        x402Version: 2,
        payload: { authorization, signature },
      };
    },
  };

  const coreClient = new core.x402Client((version, candidates) => {
    if (version !== 2) {
      throw new CounterpartyError("DACS x402 buyer only accepts protocol version 2");
    }
    const selected = candidates.find((candidate) =>
      requirementsMatch(candidate, expected));
    if (!selected) {
      throw new CounterpartyError(
        "x402 challenge requirements do not match DACS signing authority",
      );
    }
    return selected;
  }).register(authority.network, scheme);
  // @x402/core 2.24 added default spend controls after the SDK's 2.15 peer
  // floor. Keep those controls enabled when available, but derive their sole
  // asset and atomic cap from the already-authenticated DACS authority. The
  // exact selector and signing callback below remain the final fail-closed
  // boundary; this merely prevents a dependency default from rejecting the
  // authority's non-default token before those checks can run.
  const configurableCore = coreClient as unknown as {
    setSpendControls?: (controls: {
      maxAmountPerPayment: false;
      allowedAssets: Array<{
        network: string;
        asset: string;
        maxAmountPerPayment: string;
      }>;
    }) => unknown;
  };
  if (typeof configurableCore.setSpendControls === "function") {
    configurableCore.setSpendControls({
      maxAmountPerPayment: false,
      allowedAssets: [{
        network: authority.network,
        asset: expected.asset,
        maxAmountPerPayment: expected.amount,
      }],
    });
  }
  coreClient.onBeforePaymentCreation(async ({
    paymentRequired,
    selectedRequirements,
  }) => {
    if (paymentRequired.x402Version !== 2 ||
        paymentRequired.resource?.url !== authority.httpResource ||
        paymentRequired.extensions !== undefined ||
        !requirementsMatch(selectedRequirements, expected)) {
      return {
        abort: true as const,
        reason: "x402 challenge is outside DACS signing authority",
      };
    }
  });
  const httpClient = new core.x402HTTPClient(coreClient);

  return Object.freeze({
    address: account.address,
    authorizationNonce: nonce,
    isPaymentRequirementsAuthorized(
      requirements: Readonly<X402BuyerPaymentRequirements>,
    ) {
      return requirementsMatch(requirements, expected);
    },
    getPaymentRequiredResponse(
      getHeader: (name: string) => string | null | undefined,
      body?: unknown,
    ) {
      return httpClient.getPaymentRequiredResponse(getHeader, body);
    },
    async createPaymentPayload(paymentRequired: unknown) {
      const payload = await httpClient.createPaymentPayload(paymentRequired as never);
      // x402 core materializes an `extensions: undefined` convenience member.
      // It is absent on the JSON wire and therefore must also be absent from the
      // exact durable snapshot that the encoded header is compared against.
      if (payload.extensions === undefined) {
        const { extensions: _extensions, ...wirePayload } = payload;
        return wirePayload;
      }
      return payload;
    },
    encodePaymentSignatureHeader(paymentPayload: unknown) {
      return httpClient.encodePaymentSignatureHeader(paymentPayload as never);
    },
  });
}
