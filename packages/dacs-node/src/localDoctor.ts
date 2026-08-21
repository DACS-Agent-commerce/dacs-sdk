import { access, lstat, readFile, statfs } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, sep } from "node:path";

import { VERSION } from "@kynesyslabs/dacs";
import { sha256Hex } from "@kynesyslabs/dacs/canonical";
import { FIXED_PRICE_X402_STANDARD_REVISION } from "@kynesyslabs/dacs/commerce";
import {
  parseCanonicalClaimReference,
  sameCanonicalClaimIdentity,
} from "@kynesyslabs/dacs/identity";

import {
  DACS_NODE_LIVE_PROFILE,
  validateDacsAgentConfig,
  type DacsLiveAgentConfig,
} from "./config.js";
import type {
  DacsLiveDoctorProbeV1,
  DacsLiveDoctorProbesV1,
} from "./doctor.js";
import type { DacsLoadedSecretV1 } from "./secrets.js";
import {
  DACS_NODE_SQLITE_APPLICATION_ID,
  DACS_NODE_SQLITE_SCHEMA_VERSION,
  type DacsNodeSqliteDatabase,
} from "./sqlite.js";

const MINIMUM_DISK_BYTES = 256 * 1024 * 1024;

export interface DacsNodeDoctorActorV1 {
  role: "buyer" | "seller";
  config: unknown;
  database: DacsNodeSqliteDatabase;
  secrets: Readonly<{
    demosIdentity: Readonly<DacsLoadedSecretV1>;
    evmWallet: Readonly<DacsLoadedSecretV1>;
  }>;
}

export interface DacsNodeLocalDoctorOptionsV1 {
  actors: readonly Readonly<DacsNodeDoctorActorV1>[];
  nodeVersion?: string;
  minimumFreeBytes?: number;
  transportIdentities?: DacsLiveDoctorProbeV1;
  deploymentRuntime?: DacsLiveDoctorProbeV1;
}

function pass(facts?: Readonly<Record<string, string | number | boolean | null>>) {
  return Object.freeze({ status: "pass" as const, ...(facts === undefined ? {} : { facts }) });
}

function fail(reasonCode: string) {
  return Object.freeze({ status: "fail" as const, reasonCode });
}

function blocked(reasonCode: string) {
  return Object.freeze({ status: "blocked" as const, reasonCode });
}

function supportedNode(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major === 20) return minor > 19 || (minor === 19 && patch >= 0);
  if (major === 22) return minor > 12 || (minor === 12 && patch >= 0);
  return major > 22;
}

function demosAuthority(value: unknown): value is string {
  const parsed = parseCanonicalClaimReference(value);
  return parsed !== null && parsed.identity.scheme === "did" &&
    /^demos:agent:[0-9a-f]{64}$/.test(parsed.identity.identifier);
}

function capturedActors(
  input: readonly Readonly<DacsNodeDoctorActorV1>[],
): Readonly<Record<"buyer" | "seller", Readonly<DacsNodeDoctorActorV1>>> | undefined {
  if (!Array.isArray(input) || input.length !== 2) return undefined;
  const buyer = input.find((actor) => actor?.role === "buyer");
  const seller = input.find((actor) => actor?.role === "seller");
  if (buyer === undefined || seller === undefined || buyer === seller) return undefined;
  return Object.freeze({ buyer, seller });
}

function configFor(
  actor: Readonly<DacsNodeDoctorActorV1>,
): Readonly<DacsLiveAgentConfig> | undefined {
  try {
    const config = validateDacsAgentConfig(actor.config);
    return config.mode === "live-demos" && config.profile === DACS_NODE_LIVE_PROFILE &&
      config.role === actor.role ? config : undefined;
  } catch {
    return undefined;
  }
}

async function inspectDataDirectory(
  actor: Readonly<DacsNodeDoctorActorV1>,
) {
  const config = configFor(actor);
  if (config === undefined) return blocked("configuration-unavailable");
  const directory = resolve(config.dataDirectory);
  const databasePath = resolve(actor.database.databasePath);
  if (databasePath !== directory && !databasePath.startsWith(`${directory}${sep}`)) {
    return fail("database-outside-data-directory");
  }
  try {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink()) return fail("data-directory-symlink");
    if (!metadata.isDirectory()) return fail("data-directory-not-directory");
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      return fail("data-directory-permissions-unsafe");
    }
    await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
    return pass();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? blocked("data-directory-missing")
      : fail("data-directory-unavailable");
  }
}

async function inspectDisk(
  actors: Readonly<Record<"buyer" | "seller", Readonly<DacsNodeDoctorActorV1>>>,
  minimumFreeBytes: number,
) {
  try {
    let lowest: bigint | undefined;
    for (const actor of [actors.buyer, actors.seller]) {
      const config = configFor(actor);
      if (config === undefined) return blocked("configuration-unavailable");
      const stats = await statfs(resolve(config.dataDirectory), { bigint: true });
      const available = stats.bavail * stats.bsize;
      if (lowest === undefined || available < lowest) lowest = available;
    }
    if (lowest === undefined) return blocked("disk-space-unavailable");
    if (lowest < BigInt(minimumFreeBytes)) return fail("disk-space-insufficient");
    return pass({ minimumFreeBytes, availableBytesFloor: lowest.toString() });
  } catch {
    return blocked("disk-space-unavailable");
  }
}

async function packageIntegrity() {
  try {
    const parsed = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      name?: unknown;
      version?: unknown;
      peerDependencies?: Record<string, unknown>;
      exports?: Record<string, unknown>;
    };
    if (parsed.name !== "@kynesyslabs/dacs-node" || parsed.version !== VERSION ||
        parsed.peerDependencies?.["@kynesyslabs/dacs"] !== VERSION ||
        parsed.exports?.["."] === undefined || parsed.exports?.["./sqlite"] === undefined ||
        parsed.exports?.["./transport"] === undefined) {
      return fail("package-integrity-mismatch");
    }
    return pass({ packageVersion: VERSION });
  } catch {
    return fail("package-integrity-unavailable");
  }
}

function secretDigest(secret: Readonly<DacsLoadedSecretV1>): string | undefined {
  try {
    const bytes = secret.bytes();
    const digest = sha256Hex(bytes);
    bytes.fill(0);
    return digest;
  } catch {
    return undefined;
  }
}

/**
 * Construct the built-in, read-only local probes. Demos, x402 and service
 * checks remain explicit injected capabilities and therefore stay blocked
 * until the generated host wires their reviewed adapters.
 */
export function createDacsNodeLocalDoctorProbesV1(
  options: Readonly<DacsNodeLocalDoctorOptionsV1>,
): Readonly<DacsLiveDoctorProbesV1> {
  if (options === null || typeof options !== "object" ||
      !Array.isArray(options.actors) ||
      (options.transportIdentities !== undefined &&
        typeof options.transportIdentities !== "function") ||
      (options.deploymentRuntime !== undefined &&
        typeof options.deploymentRuntime !== "function")) {
    throw new TypeError("local doctor options are invalid");
  }
  const actors = capturedActors(options.actors);
  if (actors === undefined) throw new TypeError("local doctor requires one buyer and one seller");
  const nodeVersion = options.nodeVersion ?? process.version;
  const minimumFreeBytes = options.minimumFreeBytes ?? MINIMUM_DISK_BYTES;
  if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes <= 0) {
    throw new TypeError("local doctor disk threshold is invalid");
  }

  return Object.freeze({
    "local.node-version": () => supportedNode(nodeVersion)
      ? pass({ nodeVersion }) : fail("node-version-unsupported"),
    "local.package-integrity": packageIntegrity,
    "local.version-bindings": () => {
      for (const actor of [actors.buyer, actors.seller]) {
        const config = configFor(actor);
        if (config === undefined ||
            actor.database.metadata.mode !== "live-demos" ||
            actor.database.metadata.profile !== DACS_NODE_LIVE_PROFILE ||
            actor.database.metadata.role !== actor.role ||
            actor.database.metadata.sdkVersion !== VERSION ||
            actor.database.metadata.standardRevision !== FIXED_PRICE_X402_STANDARD_REVISION) {
          return fail("version-binding-mismatch");
        }
      }
      return pass({
        sdkVersion: VERSION,
        standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
        profile: DACS_NODE_LIVE_PROFILE,
      });
    },
    "local.configuration": () => {
      const buyer = configFor(actors.buyer);
      const seller = configFor(actors.seller);
      if (buyer === undefined || seller === undefined) return fail("configuration-invalid");
      if (resolve(buyer.dataDirectory) === resolve(seller.dataDirectory)) {
        return fail("actor-data-directory-shared");
      }
      return pass();
    },
    "local.data-directory": async () => {
      const results = await Promise.all([
        inspectDataDirectory(actors.buyer),
        inspectDataDirectory(actors.seller),
      ]);
      return results.find((result) => result.status === "fail") ??
        results.find((result) => result.status === "blocked") ?? pass();
    },
    "local.disk-space": () => inspectDisk(actors, minimumFreeBytes),
    "local.sqlite": () => {
      try {
        for (const actor of [actors.buyer, actors.seller]) {
          const diagnostics = actor.database.diagnostics();
          if (diagnostics.quickCheck !== "ok" || diagnostics.journalMode !== "wal" ||
              diagnostics.synchronous !== "full" || diagnostics.role !== actor.role ||
              diagnostics.schemaVersion !== DACS_NODE_SQLITE_SCHEMA_VERSION ||
              diagnostics.applicationId !== DACS_NODE_SQLITE_APPLICATION_ID ||
              !demosAuthority(diagnostics.authority)) {
            return fail("sqlite-diagnostics-mismatch");
          }
        }
        return pass();
      } catch {
        return fail("sqlite-diagnostics-unavailable");
      }
    },
    "local.secrets": () => {
      const entries = [
        actors.buyer.secrets?.demosIdentity,
        actors.buyer.secrets?.evmWallet,
        actors.seller.secrets?.demosIdentity,
        actors.seller.secrets?.evmWallet,
      ];
      if (entries.some((entry) => entry === undefined || entry.destroyed)) {
        return blocked("role-secret-missing");
      }
      if (entries.some((entry) => entry.source === "environment" ||
          entry.warningCodes.includes("secret-environment-source"))) {
        return fail("environment-secret-not-production-safe");
      }
      const digests = entries.map(secretDigest);
      if (digests.some((digest) => digest === undefined)) return fail("role-secret-unreadable");
      if (new Set(digests).size !== digests.length) return fail("role-secret-reused");
      return pass({ secretCount: entries.length });
    },
    "local.authority-separation": () => {
      const buyer = actors.buyer.database.metadata.authority;
      const seller = actors.seller.database.metadata.authority;
      if (!demosAuthority(buyer) || !demosAuthority(seller)) {
        return fail("actor-authority-invalid");
      }
      if (sameCanonicalClaimIdentity(buyer, seller)) {
        return fail("actor-authority-shared");
      }
      return pass();
    },
    ...(options.transportIdentities === undefined
      ? {} : { "local.transport-identities": options.transportIdentities }),
    ...(options.deploymentRuntime === undefined
      ? {} : { "local.deployment-runtime": options.deploymentRuntime }),
  });
}
