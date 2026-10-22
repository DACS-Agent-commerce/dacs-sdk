import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";

import { DacsError, IndeterminateSubstrateError } from "@kynesyslabs/dacs";
import { DACS_STANDARD_PROFILE_STATUS } from "@kynesyslabs/dacs/commerce";

import { dacsLiveRailProfiles } from "./config.js";
import {
  createDacsUnavailableLiveCommerceGraphV1,
  type DacsLiveCommerceAvailabilityV1,
} from "./liveCommerceGraph.js";
import type {
  DacsLiveRoleCommerceGraphV1,
  DacsLiveRoleOperationContextV1,
} from "./roleRuntime.js";

const fileAdmissionChecks = new WeakMap<Function, () => void>();

/** Largest operator admission statement the file source reads. */
export const DACS_SESSION_PROFILE_ADMISSION_FILE_MAX_BYTES = 4_096;

/**
 * Whether this host can admit any live session. The pinned Standard decides
 * first: while its profile is an unreleased candidate nothing is admissible,
 * whatever authority the host holds. Then the host must hold an independent
 * admission authority; without one every live action would be refused.
 */
export function dacsLiveSessionProfileAvailabilityV1(
  authenticateSessionProfile: unknown,
): Readonly<DacsLiveCommerceAvailabilityV1> {
  if (DACS_STANDARD_PROFILE_STATUS !== "released") {
    return Object.freeze({ status: "blocked", reasonCode: "session-profile-unreleased" });
  }
  if (typeof authenticateSessionProfile !== "function") {
    return Object.freeze({
      status: "blocked", reasonCode: "session-profile-admission-unconfigured",
    });
  }
  try { fileAdmissionChecks.get(authenticateSessionProfile)?.(); }
  catch { return Object.freeze({ status: "blocked", reasonCode: "session-profile-admission-unavailable" }); }
  return Object.freeze({ status: "configured" });
}

/**
 * Build the live graph only when sessions can be admitted. Otherwise install a
 * complete, non-performing graph for the configured rails that names the
 * reason, so the service starts and reports `commerce: blocked` instead of
 * failing on every start. The live factories keep their own admission guard.
 */
export function createDacsSessionProfileGatedCommerceGraphV1(
  createCommerceGraph: (
    context: Readonly<DacsLiveRoleOperationContextV1>,
  ) => Promise<Readonly<DacsLiveRoleCommerceGraphV1>> | Readonly<DacsLiveRoleCommerceGraphV1>,
): (
  context: Readonly<DacsLiveRoleOperationContextV1>,
) => Promise<Readonly<DacsLiveRoleCommerceGraphV1>> {
  if (typeof createCommerceGraph !== "function") {
    throw new TypeError("session profile gated commerce graph requires a graph factory");
  }
  return async (context) => {
    const availability = dacsLiveSessionProfileAvailabilityV1(context.authenticateSessionProfile);
    if (availability.status === "configured") return createCommerceGraph(context);
    const rails = dacsLiveRailProfiles(context.config);
    const { operations, ...unavailable } = createDacsUnavailableLiveCommerceGraphV1({
      role: context.role,
      reasonCode: availability.reasonCode,
    });
    // An operator file outage is retryable even when it was absent at startup.
    // Permanent profile/configuration refusals still require operator action.
    const retryable = availability.reasonCode === "session-profile-admission-unavailable";
    const retry = async (): Promise<never> => {
      throw new IndeterminateSubstrateError("session profile admission file is unavailable");
    };
    const roleOperations = retryable ? Object.freeze(Object.fromEntries(
      Object.keys(operations).map((key) => [key, retry]))) : operations;
    const validatePayload = retryable ? () => Object.freeze({
      status: "unavailable" as const, reasonCode: availability.reasonCode,
    }) : unavailable.validatePayload;
    const handleMessage = retryable ? retry : unavailable.handleMessage;
    return Object.freeze({
      ...unavailable, validatePayload, handleMessage,
      router: Object.freeze({ ...unavailable.router, validatePayload, handleMessage }),
      ...(rails.includes("x402") ? { operations: roleOperations } : {}),
      ...(rails.includes("pay-dem")
        ? { payDemOperations: roleOperations as unknown as DacsLiveRoleCommerceGraphV1["payDemOperations"] }
        : {}),
    }) as Readonly<DacsLiveRoleCommerceGraphV1>;
  };
}

export interface DacsFileSessionProfileAdmissionOptionsV1 {
  /** Operator-owned statement of the admitted Standard release. */
  filePath: string;
  /** The deployment's configured role authorities, never peer artifacts. */
  buyerAuthority: string;
  sellerAuthority: string;
}

/**
 * Deployment admission read from an operator-owned file:
 * `{ "releasePin", "profileStatus", "moduleVersions" }`. The roles are the
 * configured buyer and seller authorities. The file is read again for every
 * action, so a saved success is never authority, and the SDK still checks the
 * statement against its own pin, status and module tuple.
 */
export function createDacsFileSessionProfileAdmissionV1(
  options: Readonly<DacsFileSessionProfileAdmissionOptionsV1>,
): (jobId: string) => Readonly<Record<string, unknown>> {
  if (options === null || typeof options !== "object" ||
      typeof options.filePath !== "string" || options.filePath.length === 0 ||
      typeof options.buyerAuthority !== "string" || options.buyerAuthority.length === 0 ||
      typeof options.sellerAuthority !== "string" || options.sellerAuthority.length === 0) {
    throw new TypeError("file session profile admission options are invalid");
  }
  const filePath = resolve(options.filePath);
  const buyer = options.buyerAuthority;
  const seller = options.sellerAuthority;
  const authenticate = (jobId: string) => {
    const statement = readAdmissionStatement(filePath);
    return Object.freeze({
      status: "valid",
      releasePin: statement.releasePin,
      profileStatus: statement.profileStatus,
      moduleVersions: statement.moduleVersions,
      roles: Object.freeze([
        Object.freeze({ jobId, participant: buyer, role: "buyer" }),
        Object.freeze({ jobId, participant: seller, role: "seller" }),
      ]),
    });
  };
  fileAdmissionChecks.set(authenticate, () => { readAdmissionStatement(filePath); });
  return authenticate;
}

function readAdmissionStatement(filePath: string): Readonly<Record<string, unknown>> {
  let text: string;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filePath, "r");
    const size = fstatSync(descriptor).size;
    if (size > DACS_SESSION_PROFILE_ADMISSION_FILE_MAX_BYTES) {
      throw new DacsError(`session profile admission file exceeds ${
        DACS_SESSION_PROFILE_ADMISSION_FILE_MAX_BYTES} bytes`);
    }
    // Read one byte past the limit so a file that grew after fstat is refused.
    const buffer = Buffer.alloc(DACS_SESSION_PROFILE_ADMISSION_FILE_MAX_BYTES + 1);
    let length = 0;
    for (let read = -1; read !== 0 && length < buffer.length;) {
      read = readSync(descriptor, buffer, length, buffer.length - length, null);
      length += read;
    }
    if (length > DACS_SESSION_PROFILE_ADMISSION_FILE_MAX_BYTES) {
      throw new DacsError(`session profile admission file exceeds ${
        DACS_SESSION_PROFILE_ADMISSION_FILE_MAX_BYTES} bytes`);
    }
    text = buffer.subarray(0, length).toString("utf8");
  } catch (error) {
    if (error instanceof DacsError) throw error;
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT") {
      throw new IndeterminateSubstrateError("session profile admission file is absent", { cause: error });
    }
    if (code === "EACCES" || code === "EPERM" || code === "EISDIR") {
      throw new IndeterminateSubstrateError("session profile admission file is not readable", { cause: error });
    }
    throw new IndeterminateSubstrateError("session profile admission file read failed", { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (error) {
    throw new DacsError("session profile admission file is not JSON", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.keys(parsed).sort().join() !== "moduleVersions,profileStatus,releasePin") {
    throw new DacsError("session profile admission file must state exactly " +
      "releasePin, profileStatus and moduleVersions");
  }
  const statement = parsed as Record<string, unknown>;
  if (typeof statement.releasePin !== "string" || typeof statement.profileStatus !== "string" ||
      statement.moduleVersions === null || typeof statement.moduleVersions !== "object" ||
      Array.isArray(statement.moduleVersions)) {
    throw new DacsError("session profile admission file is malformed");
  }
  return Object.freeze(statement);
}
