import { lstat, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { types as nodeTypes } from "node:util";

import {
  createFsWalletSpendStateStoreV1,
  createWalletSpendAuthorityV1,
  type WalletSpendAuthorityDependenciesV1,
  type WalletSpendAuthorityV1,
  type WalletSpendPolicyV1,
} from "@kynesyslabs/dacs";

import { loadDacsSecretV1 } from "./secrets.js";

const HEX_KEY_RE = /^[0-9a-fA-F]{64}$/;
const REQUIRED_OPTION_KEYS = Object.freeze([
  "policy",
  "dataDirectory",
  "integrityKeyFilePath",
  "readBalance",
  "authenticateRecovery",
] as const);
const OPTIONAL_OPTION_KEYS = new Set([
  "stateDirectory",
  "verifyOperatorApproval",
  "owner",
  "leaseDurationMs",
]);

export interface DacsWalletSpendRuntimeOptionsV1 {
  policy: Readonly<WalletSpendPolicyV1>;
  dataDirectory: string;
  integrityKeyFilePath: string;
  stateDirectory?: string;
  readBalance: WalletSpendAuthorityDependenciesV1["readBalance"];
  authenticateRecovery: WalletSpendAuthorityDependenciesV1["authenticateRecovery"];
  verifyOperatorApproval?: WalletSpendAuthorityDependenciesV1[
    "verifyOperatorApproval"
  ];
  owner?: string;
  leaseDurationMs?: number;
}

export class DacsWalletSpendRuntimeError extends Error {
  override readonly name = "DacsWalletSpendRuntimeError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function ownCanonicalData(
  value: unknown,
  ancestors = new Set<object>(),
): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new TypeError();
    }
    return value;
  }
  if (typeof value !== "object" || nodeTypes.isProxy(value) || ancestors.has(value)) {
    throw new TypeError();
  }

  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) throw new TypeError();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) throw new TypeError();
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 ||
          keys.length !== length + 1) {
        throw new TypeError();
      }
      const copy: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor) ||
            !descriptor.enumerable || descriptor.value === undefined) {
          throw new TypeError();
        }
        copy.push(ownCanonicalData(descriptor.value, ancestors));
      }
      return Object.freeze(copy);
    }

    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const copy: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) ||
          !descriptor.enumerable || descriptor.value === undefined) {
        throw new TypeError();
      }
      Object.defineProperty(copy, key, {
        value: ownCanonicalData(descriptor.value, ancestors),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(copy);
  } finally {
    ancestors.delete(value);
  }
}

function capturePolicySynchronously(
  value: unknown,
): Readonly<WalletSpendPolicyV1> {
  try {
    return ownCanonicalData(value) as Readonly<WalletSpendPolicyV1>;
  } catch {
    throw new TypeError("wallet spend policy must be stable canonical data");
  }
}

function captureOptions(
  value: unknown,
): Readonly<DacsWalletSpendRuntimeOptionsV1> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) ||
        nodeTypes.isProxy(value)) {
      throw new TypeError();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const keys = Reflect.ownKeys(value);
    if (REQUIRED_OPTION_KEYS.some((key) => !keys.includes(key)) ||
        keys.some((key) => typeof key !== "string" ||
          (!REQUIRED_OPTION_KEYS.includes(key as typeof REQUIRED_OPTION_KEYS[number]) &&
            !OPTIONAL_OPTION_KEYS.has(key)))) {
      throw new TypeError();
    }
    const captured: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string") throw new TypeError();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError();
      }
      captured[key] = descriptor.value;
    }
    if (typeof captured.dataDirectory !== "string" ||
        typeof captured.integrityKeyFilePath !== "string" ||
        typeof captured.readBalance !== "function" ||
        typeof captured.authenticateRecovery !== "function" ||
        (captured.stateDirectory !== undefined &&
          typeof captured.stateDirectory !== "string") ||
        (captured.verifyOperatorApproval !== undefined &&
          typeof captured.verifyOperatorApproval !== "function") ||
        (captured.owner !== undefined && typeof captured.owner !== "string") ||
        (captured.leaseDurationMs !== undefined &&
          typeof captured.leaseDurationMs !== "number")) {
      throw new TypeError();
    }
    return Object.freeze(captured) as unknown as
      Readonly<DacsWalletSpendRuntimeOptionsV1>;
  } catch {
    throw new TypeError("wallet spend runtime options must be a closed data object");
  }
}

async function admitDataDirectory(path: string): Promise<string> {
  const requested = resolve(path);
  let metadata;
  let canonical;
  try {
    [metadata, canonical] = await Promise.all([lstat(requested), realpath(requested)]);
  } catch {
    throw new DacsWalletSpendRuntimeError("wallet-spend-data-directory-unavailable");
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new DacsWalletSpendRuntimeError("wallet-spend-data-directory-unsafe");
  }
  return canonical;
}

/**
 * Open one process-private view of a wallet/chain authority. Independent role
 * processes using the same policy directory serialize through the core store;
 * the MAC key is loaded from a separate role-owned secret and destroyed after
 * the store has copied it.
 */
export async function createDacsWalletSpendAuthorityV1(
  options: Readonly<DacsWalletSpendRuntimeOptionsV1>,
): Promise<Readonly<WalletSpendAuthorityV1>> {
  const captured = captureOptions(options);
  // Policy is authority, not late configuration. Own the complete JSON graph
  // before directory, key, or store initialization yields to caller code.
  const policy = capturePolicySynchronously(captured.policy);
  const dataDirectory = await admitDataDirectory(captured.dataDirectory);
  const stateDirectory = resolve(
    captured.stateDirectory ?? resolve(dataDirectory, "wallet-spend"),
  );
  if (stateDirectory !== dataDirectory &&
      !stateDirectory.startsWith(`${dataDirectory}${sep}`)) {
    throw new DacsWalletSpendRuntimeError("wallet-spend-state-outside-data-directory");
  }
  const secret = await loadDacsSecretV1({
    name: "wallet-spend-integrity",
    mode: "live-demos",
    filePath: resolve(captured.integrityKeyFilePath),
  });
  let key: Uint8Array | undefined;
  try {
    const encoded = secret.text().trim();
    if (!HEX_KEY_RE.test(encoded)) {
      throw new DacsWalletSpendRuntimeError("wallet-spend-integrity-key-invalid");
    }
    key = Uint8Array.from(Buffer.from(encoded, "hex"));
    const store = await createFsWalletSpendStateStoreV1({
      dir: stateDirectory,
      integrityKey: key,
    });
    return createWalletSpendAuthorityV1(policy, {
      store,
      readBalance: captured.readBalance,
      authenticateRecovery: captured.authenticateRecovery,
      ...(captured.verifyOperatorApproval === undefined
        ? {}
        : { verifyOperatorApproval: captured.verifyOperatorApproval }),
      ...(captured.owner === undefined ? {} : { owner: captured.owner }),
      ...(captured.leaseDurationMs === undefined
        ? {}
        : { leaseDurationMs: captured.leaseDurationMs }),
    });
  } finally {
    key?.fill(0);
    secret.destroy();
  }
}
