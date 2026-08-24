import { lstat, mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  createPayDemRail as createSdkPayDemRail,
  type PayDemRail,
  type PayDemSettleParams,
  type ProtocolAnchorReceipt,
} from "@kynesyslabs/dacs";
import type { ComponentSigner } from "@kynesyslabs/dacs/artifacts";
import {
  canonicalDemosAgentPublicKey,
  demosAgentClaimRef,
  sameCanonicalClaimIdentity,
} from "@kynesyslabs/dacs/identity";
import type {
  AnchorRef,
  AnchorResolution,
  AnchorWriteOnceOptions,
  DemosWriteJournal,
  DemosWriteJournalLease,
  DemosWriteJournalRecord,
  OwnedAnchorScan,
  ResolvedIdentity,
} from "@kynesyslabs/dacs/substrate";

import {
  DACS_NODE_LIVE_PROFILE,
  dacsLiveRailProfiles,
  validateDacsAgentConfig,
  type DacsLiveAgentConfig,
} from "./config.js";
import type { DacsLoadedSecretV1 } from "./secrets.js";
import type {
  DacsHttpEnvelopeSigner,
  DacsHttpIdentityResolverV1,
  DacsHttpMessageType,
} from "./transport/envelope.js";

const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_IDENTITY_EVIDENCE_BYTES = 1_048_576;
const ROLE_BY_MESSAGE: Readonly<
  Record<Exclude<DacsHttpMessageType, "acknowledgement">, "buyer" | "seller">
> = Object.freeze({
  "session-init": "buyer",
  "session-challenge": "seller",
  "session-presentation": "buyer",
  "session-admission": "seller",
  "agreement-proposal": "buyer",
  "agreement-response": "seller",
  "pay-dem-payment-notice": "buyer",
  "payment-evidence-request": "seller",
  "payment-evidence-completion": "buyer",
  "bundle-signature-request": "seller",
  "bundle-signature-response": "buyer",
  "diagnostic-probe-buyer": "buyer",
  "diagnostic-probe-seller": "seller",
});

export interface DacsDemosAdapterV1 {
  readonly raw: Readonly<{
    getNetworkInfo(): Promise<unknown>;
    getAddressNonce(address: string): Promise<number>;
    getAddressInfo(address: string): Promise<unknown>;
  }>;
  connect(): Promise<void>;
  getChainIdentity?(): Promise<string>;
  getAddress(): string;
  getPublicKey(): Promise<Uint8Array>;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
  resolveIdentity(ref: string): Promise<ResolvedIdentity>;
  readAnchor(address: string): Promise<Record<string, unknown> | null>;
  resolveAnchorByName(
    name: string,
    expectedOwner: string,
  ): Promise<AnchorResolution>;
  scanOwnAnchorsByNamePrefix(prefix: string): Promise<OwnedAnchorScan>;
  anchorWriteOnce(
    name: string,
    value: object,
    options?: AnchorWriteOnceOptions,
  ): Promise<AnchorRef>;
  verifyDemosAnchorReceipt(
    receipt: Readonly<ProtocolAnchorReceipt>,
  ): Promise<boolean>;
  resolveDemosAnchorReceipt(input: Readonly<{
    logicalAddress: string;
    nativeAddress: string;
    contentHash: string;
    writer: string;
  }>): Promise<ProtocolAnchorReceipt | null>;
  reconcileNativeTransferJournal(
    lease: DemosWriteJournalLease,
    timeoutMs?: number,
  ): Promise<void>;
}

export interface DacsDemosActorRuntimeOptionsV1 {
  config: unknown;
  role: "buyer" | "seller";
  authority: string;
  demosIdentity: Readonly<DacsLoadedSecretV1>;
  journalDirectory?: string;
  /** Read-only probes receive an adapter whose journal rejects every write lease. */
  writePolicy?: "perform" | "read-only";
  /** Deterministic test/custom-host seam. Production omits this callback. */
  createAdapter?: (input: Readonly<{
    rpc: string;
    secret: string;
    writeJournal: DemosWriteJournal;
  }>) => Promise<DacsDemosAdapterV1> | DacsDemosAdapterV1;
  /** Deterministic test/custom-host seam. Production uses the SDK native rail. */
  createPayDemRail?: (input: Readonly<{
    rpc: string;
    secret: string;
    network: "demos";
  }>) => Promise<Readonly<PayDemRail>> | Readonly<PayDemRail>;
}

export interface DacsDemosActorRuntimeV1 {
  readonly role: "buyer" | "seller";
  readonly authority: string;
  readonly walletAddress: string;
  readonly publicKey: Uint8Array;
  readonly adapter: DacsDemosAdapterV1;
  /** Present only for a write-enabled native-DEM buyer authority. */
  readonly payDem?: Readonly<{ rail: Readonly<PayDemRail> }>;
  readonly signTransportEnvelope: DacsHttpEnvelopeSigner;
  /** Role-bound component signer; rejects substituted signer or algorithm context. */
  readonly signComponent: ComponentSigner;
  networkInfo(): Promise<unknown>;
  chainIdentity?(): Promise<string>;
  addressNonce(): Promise<number>;
  addressInfo(): Promise<unknown>;
}

export interface DacsDemosIdentityResolverOptionsV1 {
  runtime: Readonly<DacsDemosActorRuntimeV1>;
  peerAuthority: string;
  peerRole: "buyer" | "seller";
  /**
   * Optional retained-session authorization check. Agreement proposals and
   * diagnostics can establish direction from their authenticated message type;
   * existing-session hosts should supply this for every later message.
   */
  authorizeJob?: (input: Readonly<{
    jobId: string;
    sender: string;
    role: "buyer" | "seller";
    messageType: DacsHttpMessageType;
  }>) => Promise<boolean> | boolean;
}

export class DacsDemosRuntimeError extends Error {
  override readonly name = "DacsDemosRuntimeError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function text(value: unknown, maximum = 4_096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value.trim() === value && !value.includes("\0");
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

function exactPrimaryAuthority(value: unknown): value is string {
  const publicKey = canonicalDemosAgentPublicKey(value);
  return publicKey !== null && value === demosAgentClaimRef(publicKey);
}

function canonicalWalletAddress(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() !== value) return null;
  return value.match(/^(?:0[xX])?([0-9a-fA-F]{64})$/)?.[1]?.toLowerCase() ?? null;
}

function snapshotSecretText(secret: Readonly<DacsLoadedSecretV1>): string {
  if (secret.destroyed) throw new DacsDemosRuntimeError("demos-secret-destroyed");
  let value: string;
  try {
    value = secret.text().trim();
  } catch {
    throw new DacsDemosRuntimeError("demos-secret-invalid");
  }
  if (!text(value, 65_536)) throw new DacsDemosRuntimeError("demos-secret-invalid");
  return value;
}

async function privateJournalDirectory(
  config: Readonly<DacsLiveAgentConfig>,
  configured: string | undefined,
): Promise<string> {
  const dataDirectory = resolve(config.dataDirectory);
  const directory = resolve(configured ?? resolve(dataDirectory, "demos-write-journal"));
  if (directory !== dataDirectory && !directory.startsWith(`${dataDirectory}${sep}`)) {
    throw new DacsDemosRuntimeError("demos-journal-outside-data-directory");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const observed = await lstat(directory);
  if (!observed.isDirectory() || observed.isSymbolicLink() ||
      (process.platform !== "win32" && (observed.mode & 0o077) !== 0) ||
      (typeof process.getuid === "function" && observed.uid !== process.getuid())) {
    throw new DacsDemosRuntimeError("demos-journal-directory-unsafe");
  }
  return directory;
}

async function defaultAdapter(input: Readonly<{
  rpc: string;
  secret: string;
  writeJournal: DemosWriteJournal;
}>): Promise<DacsDemosAdapterV1> {
  const substrate = await import("@kynesyslabs/dacs/substrate").catch(() => {
    throw new DacsDemosRuntimeError("demos-adapter-unavailable");
  });
  return new substrate.DemosAdapter(input) as DacsDemosAdapterV1;
}

function walletCoordinatedPayDemRail(input: Readonly<{
  rail: Readonly<PayDemRail>;
  journal: Readonly<DemosWriteJournal>;
  adapter: Readonly<DacsDemosAdapterV1>;
  chainIdentity(): Promise<string>;
  wallet: string;
}>): Readonly<PayDemRail> {
  const wallet = canonicalWalletAddress(input.wallet);
  if (wallet === null) {
    throw new DacsDemosRuntimeError("demos-pay-dem-wallet-authority-invalid");
  }
  const journalWallet = input.wallet.toLowerCase();
  return Object.freeze({
    address: input.rail.address,
    async settle(params: PayDemSettleParams) {
      if (!plainObject(params)) {
        throw new DacsDemosRuntimeError("demos-pay-dem-settlement-input-invalid");
      }
      const settlement = params as PayDemSettleParams;
      const callerJournal = settlement.journalPreparedTransfer;
      const callerFence = settlement.assertCurrentBeforeBroadcast;
      const lease = await input.journal.acquire({
        chainIdentity: await input.chainIdentity(),
        wallet: journalWallet,
      });
      let record: DemosWriteJournalRecord | undefined;
      try {
        await input.adapter.reconcileNativeTransferJournal(lease);
        const result = await input.rail.settle({
          ...settlement,
          journalPreparedTransfer: async (prepared) => {
            if (prepared.denomination !== "os" && prepared.denomination !== "dem") {
              throw new DacsDemosRuntimeError(
                "demos-pay-dem-prepared-denomination-unavailable",
              );
            }
            if (callerJournal !== undefined) {
              await callerJournal(prepared);
            }
            const transfer = Object.freeze({
              payer: prepared.payer,
              payee: prepared.payee,
              amountOs: prepared.amountOs,
              denomination: prepared.denomination,
              network: prepared.network,
              ...(prepared.maxTotalDebitOs === undefined
                ? {} : { maxTotalDebitOs: prepared.maxTotalDebitOs }),
              ...(prepared.recovery === undefined
                ? {} : { settlementKey: prepared.recovery.settlementKey }),
            });
            const valueHash = sha256Hex(canonicalize({
              txHash: prepared.txHash,
              nonce: prepared.nonce,
              transfer,
            }));
            record = {
              writeId: `pay-dem-${valueHash}`,
              generation: lease.generation,
              kind: "native-transfer",
              operation: "transfer",
              stage: "prepared",
              logicalName: `pay-dem:${prepared.recovery?.settlementKey ?? prepared.txHash}`,
              programName: "native-dem-transfer",
              owner: prepared.payer,
              nativeAddress: prepared.payee,
              valueHash,
              nonce: prepared.nonce,
              txRef: prepared.txHash,
              transfer,
              updatedAt: Date.now(),
            };
            await lease.put(record);
          },
          assertCurrentBeforeBroadcast: async () => {
            if (callerFence !== undefined) await callerFence();
            await lease.assertCurrent();
            if (record === undefined) {
              throw new DacsDemosRuntimeError("demos-pay-dem-prepared-record-missing");
            }
            record = {
              ...record,
              generation: lease.generation,
              stage: "broadcast-intent",
              updatedAt: Date.now(),
            };
            await lease.put(record);
          },
        });
        if (result.ok) {
          if (record === undefined || result.txHash !== record.txRef) {
            throw new DacsDemosRuntimeError("demos-pay-dem-result-record-mismatch");
          }
          await input.adapter.reconcileNativeTransferJournal(lease);
          const retained = lease.snapshot.records.find((candidate) =>
            candidate.writeId === record?.writeId);
          if (retained?.stage !== "canonical-confirmed") {
            throw new DacsDemosRuntimeError("demos-pay-dem-wallet-finality-unavailable");
          }
        }
        return result;
      } finally {
        await lease.release();
      }
    },
  });
}

/**
 * Open one role-owned live Demos wallet with the SDK's durable cross-process
 * write journal, prove that its Ed25519 public key is the configured primary
 * ClaimRef, and expose only the bounded host capabilities used by role wiring.
 */
export async function createDacsDemosActorRuntimeV1(
  rawOptions: Readonly<DacsDemosActorRuntimeOptionsV1>,
): Promise<Readonly<DacsDemosActorRuntimeV1>> {
  if (!plainObject(rawOptions) ||
      (rawOptions.role !== "buyer" && rawOptions.role !== "seller") ||
      !exactPrimaryAuthority(rawOptions.authority) ||
      rawOptions.demosIdentity === null ||
      typeof rawOptions.demosIdentity !== "object" ||
      typeof rawOptions.demosIdentity.destroyed !== "boolean" ||
      typeof rawOptions.demosIdentity.text !== "function" ||
      typeof rawOptions.demosIdentity.destroy !== "function" ||
      (rawOptions.journalDirectory !== undefined &&
        typeof rawOptions.journalDirectory !== "string") ||
      (rawOptions.writePolicy !== undefined && rawOptions.writePolicy !== "perform" &&
        rawOptions.writePolicy !== "read-only") ||
      (rawOptions.createAdapter !== undefined &&
        typeof rawOptions.createAdapter !== "function") ||
      (rawOptions.createPayDemRail !== undefined &&
        typeof rawOptions.createPayDemRail !== "function")) {
    throw new TypeError("Demos actor runtime options are invalid");
  }
  const config = validateDacsAgentConfig(rawOptions.config);
  if (config.mode !== "live-demos" || config.profile !== DACS_NODE_LIVE_PROFILE ||
      config.role !== rawOptions.role) {
    throw new TypeError("Demos actor runtime configuration is role-incompatible");
  }
  const authority = rawOptions.authority;
  let secret: string;
  try {
    secret = snapshotSecretText(rawOptions.demosIdentity);
  } catch (error) {
    rawOptions.demosIdentity.destroy();
    throw error;
  }
  let adapter: DacsDemosAdapterV1;
  let payDemRail: Readonly<PayDemRail> | undefined;
  try {
    let writeJournal: DemosWriteJournal;
    if (rawOptions.writePolicy === "read-only") {
      writeJournal = Object.freeze({
        async acquire() {
          throw new DacsDemosRuntimeError("demos-write-disabled");
        },
      });
    } else {
      const journalDirectory = await privateJournalDirectory(
        config,
        rawOptions.journalDirectory,
      );
      // The journal is exported from the substrate-neutral root barrel. Loading
      // it must not eagerly initialize the optional demosdk peer: custom hosts
      // and tests can inject an adapter without that peer being installed.
      const substrate = await import("@kynesyslabs/dacs").catch(() => {
        throw new DacsDemosRuntimeError("demos-journal-unavailable");
      });
      writeJournal = await substrate.createFsDemosWriteJournal({
        dir: journalDirectory,
      });
    }
    const makeAdapter = rawOptions.createAdapter ?? defaultAdapter;
    try {
      adapter = await makeAdapter({ rpc: config.demos.rpcUrl, secret, writeJournal });
      await adapter.connect();
      if (rawOptions.role === "buyer" && rawOptions.writePolicy !== "read-only" &&
          dacsLiveRailProfiles(config).includes("pay-dem")) {
        const makePayDemRail = rawOptions.createPayDemRail ?? createSdkPayDemRail;
        const uncoordinated = await makePayDemRail({
          rpc: config.demos.rpcUrl,
          secret,
          network: "demos",
        });
        if (adapter.getChainIdentity === undefined ||
            typeof adapter.reconcileNativeTransferJournal !== "function") {
          throw new DacsDemosRuntimeError("demos-pay-dem-wallet-coordinator-unavailable");
        }
        payDemRail = walletCoordinatedPayDemRail({
          rail: uncoordinated,
          journal: writeJournal,
          adapter,
          chainIdentity: () => adapter.getChainIdentity!(),
          wallet: adapter.getAddress(),
        });
      }
    } catch {
      throw new DacsDemosRuntimeError("demos-adapter-connect-failed");
    }
  } finally {
    rawOptions.demosIdentity.destroy();
    secret = "";
  }
  let publicKey: Uint8Array;
  let walletAddress: string;
  try {
    publicKey = Uint8Array.from(await adapter.getPublicKey());
    walletAddress = adapter.getAddress();
  } catch {
    throw new DacsDemosRuntimeError("demos-wallet-identity-unavailable");
  }
  if (publicKey.byteLength !== 32 || demosAgentClaimRef(publicKey) !== authority ||
      !text(walletAddress, 256)) {
    publicKey.fill(0);
    throw new DacsDemosRuntimeError("demos-wallet-authority-mismatch");
  }
  if (payDemRail !== undefined &&
      (typeof payDemRail.settle !== "function" ||
        canonicalWalletAddress(payDemRail.address) === null ||
        canonicalWalletAddress(payDemRail.address) !== canonicalWalletAddress(walletAddress))) {
    publicKey.fill(0);
    throw new DacsDemosRuntimeError("demos-pay-dem-wallet-authority-mismatch");
  }
  const retainedPublicKey = Uint8Array.from(publicKey);
  publicKey.fill(0);
  const signTransportEnvelope: DacsHttpEnvelopeSigner = async (bytes) => {
    const signature = await adapter.sign(Uint8Array.from(bytes));
    if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) {
      throw new DacsDemosRuntimeError("demos-transport-signature-invalid");
    }
    return Uint8Array.from(signature);
  };
  const signComponent: ComponentSigner = async (bytes, context) => {
    if (context.algorithm !== "ed25519" ||
        !sameCanonicalClaimIdentity(context.signer, authority)) {
      throw new DacsDemosRuntimeError("demos-component-signature-authority-mismatch");
    }
    const signature = await adapter.sign(Uint8Array.from(bytes));
    if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) {
      throw new DacsDemosRuntimeError("demos-component-signature-invalid");
    }
    return Uint8Array.from(signature);
  };
  return Object.freeze({
    role: rawOptions.role,
    authority,
    walletAddress,
    get publicKey() {
      return Uint8Array.from(retainedPublicKey);
    },
    adapter,
    ...(payDemRail === undefined
      ? {}
      : { payDem: Object.freeze({ rail: payDemRail }) }),
    signTransportEnvelope,
    signComponent,
    networkInfo: () => adapter.raw.getNetworkInfo(),
    chainIdentity: async () => {
      if (adapter.getChainIdentity === undefined) {
        throw new DacsDemosRuntimeError("demos-chain-identity-unavailable");
      }
      return adapter.getChainIdentity();
    },
    addressNonce: () => adapter.raw.getAddressNonce(walletAddress),
    addressInfo: () => adapter.raw.getAddressInfo(walletAddress),
  });
}

function identityEvidenceHash(sender: string, raw: unknown): string | undefined {
  try {
    const encoded = canonicalize({
      profile: "demos-primary-self-certifying:v1",
      sender,
      resolution: raw,
    });
    if (Buffer.byteLength(encoded, "utf8") > MAX_IDENTITY_EVIDENCE_BYTES) return undefined;
    const hash = sha256Hex(encoded);
    return HASH_RE.test(hash) ? hash : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a configured peer through the connected Demos identity surface and
 * bind the self-certifying primary key to the authenticated transport role.
 * This does not accept a locally supplied alternate key or delegated subkey.
 */
export function createDacsDemosIdentityResolverV1(
  rawOptions: Readonly<DacsDemosIdentityResolverOptionsV1>,
): DacsHttpIdentityResolverV1 {
  if (!plainObject(rawOptions) || !exactPrimaryAuthority(rawOptions.peerAuthority) ||
      (rawOptions.peerRole !== "buyer" && rawOptions.peerRole !== "seller") ||
      rawOptions.runtime === null || typeof rawOptions.runtime !== "object" ||
      typeof rawOptions.runtime.adapter?.resolveIdentity !== "function" ||
      (rawOptions.authorizeJob !== undefined &&
        typeof rawOptions.authorizeJob !== "function") ||
      sameCanonicalClaimIdentity(rawOptions.runtime.authority, rawOptions.peerAuthority)) {
    throw new TypeError("Demos identity resolver options are invalid");
  }
  const runtime = rawOptions.runtime;
  const peerAuthority = rawOptions.peerAuthority;
  const peerRole = rawOptions.peerRole;
  const authorizeJob = rawOptions.authorizeJob?.bind(rawOptions);
  return async (input) => {
    const requiredRole = input.messageType === "acknowledgement"
      ? peerRole
      : ROLE_BY_MESSAGE[input.messageType];
    if (input.sender !== peerAuthority || input.keyId !== input.sender ||
        requiredRole !== peerRole) {
      return Object.freeze({
        status: "rejected" as const,
        reasonCode: "identity-role-incompatible" as const,
      });
    }
    if (authorizeJob !== undefined) {
      let authorized = false;
      try {
        authorized = await authorizeJob({
          jobId: input.jobId,
          sender: input.sender,
          role: peerRole,
          messageType: input.messageType,
        });
      } catch {
        authorized = false;
      }
      if (!authorized) {
        return Object.freeze({
          status: "rejected" as const,
          reasonCode: "identity-role-incompatible" as const,
        });
      }
    }
    let resolved: ResolvedIdentity;
    try {
      resolved = await runtime.adapter.resolveIdentity(peerAuthority);
    } catch {
      return Object.freeze({
        status: "rejected" as const,
        reasonCode: "identity-unresolved" as const,
      });
    }
    if (!sameCanonicalClaimIdentity(resolved.ref, peerAuthority) ||
        (resolved.boundTo !== undefined &&
          !sameCanonicalClaimIdentity(resolved.boundTo, peerAuthority))) {
      return Object.freeze({
        status: "rejected" as const,
        reasonCode: "identity-ambiguous" as const,
      });
    }
    const publicKey = canonicalDemosAgentPublicKey(peerAuthority);
    const evidenceHash = identityEvidenceHash(peerAuthority, resolved.raw);
    if (publicKey === null || evidenceHash === undefined) {
      return Object.freeze({
        status: "rejected" as const,
        reasonCode: "identity-ambiguous" as const,
      });
    }
    return Object.freeze({
      status: "authenticated" as const,
      principal: peerAuthority,
      jobId: input.jobId,
      role: peerRole,
      publicKey,
      evidenceHash,
    });
  };
}
