import { lstat, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

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

function captureOptions(
  value: unknown,
): Readonly<DacsWalletSpendRuntimeOptionsV1> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
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
    return createWalletSpendAuthorityV1(captured.policy, {
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
