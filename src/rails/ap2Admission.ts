import { types as nodeTypes } from "node:util";

import { snapshotWireJsonRead } from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";
import { requireCanonicalJobId } from "../negotiate/jobId.js";

export interface Ap2CorrectiveProfile {
  releasePin: string;
  moduleVersions: Readonly<Record<"core" | "dacs1" | "dacs2" | "dacs3" | "dacs4" | "dacs5", string>>;
}
export interface Ap2ParticipantProfile extends Ap2CorrectiveProfile {
  jobId: string;
  identity: string;
  authenticated: boolean;
}
/** Opaque process-local capability; copied objects and reference labels have no authority. */
export interface Ap2ProfileAdmission { readonly kind: "ap2-profile-admission" }
const admitted = new WeakMap<Ap2ProfileAdmission, { jobId: string; peerIdentity: string }>();
const modules = ["core", "dacs1", "dacs2", "dacs3", "dacs4", "dacs5"] as const;
/**
 * The corrective module tuple this implementation implements (PROFILE.md at
 * the pinned DACS-Standard revision). CORE §11.1.2(3): local policy naming a
 * different tuple is refused.
 */
export const AP2_IMPLEMENTED_MODULE_VERSIONS: Ap2CorrectiveProfile["moduleVersions"] = Object.freeze({
  core: "0.3", dacs1: "0.7", dacs2: "0.6", dacs3: "0.5", dacs4: "0.8", dacs5: "0.5",
});
function exact(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function validProfile(value: Ap2CorrectiveProfile): boolean {
  return typeof value.releasePin === "string" && value.releasePin.length === 40 && /^[0-9a-f]{40}$/.test(value.releasePin) &&
    value.moduleVersions !== null && typeof value.moduleVersions === "object" &&
    exact(value.moduleVersions, modules) && modules.every((key) => {
      const version = value.moduleVersions[key];
      return typeof version === "string" && /^\d+\.\d+$/.exec(version)?.[0] === version;
    });
}
/**
 * Call from the enclosing handler with local policy and its authenticated
 * handshake resolver, never with checkout/phase-provided profile authority.
 * The resolver authenticates every record's identity, session and full profile.
 */
export async function authenticateAp2ProfileAdmission(input: {
  jobId: string;
  peerIdentity: string;
  expectedProfile: Ap2CorrectiveProfile;
  authenticateParticipants(): Promise<readonly Ap2ParticipantProfile[]>;
}): Promise<Ap2ProfileAdmission> {
  if (!input || typeof input !== "object" || nodeTypes.isProxy(input) ||
      !exact(input, ["jobId", "peerIdentity", "expectedProfile", "authenticateParticipants"]) ||
      Reflect.ownKeys(input).some((key) => typeof key !== "string" || !("value" in Object.getOwnPropertyDescriptor(input, key)!))) {
    throw new DacsError("pay-ap2: profile authority must be closed stable data");
  }
  const authenticateParticipants = input.authenticateParticipants;
  if (typeof authenticateParticipants !== "function" || nodeTypes.isProxy(authenticateParticipants)) {
    throw new DacsError("pay-ap2: missing authenticated handshake resolver");
  }
  const jobId = requireCanonicalJobId(input.jobId, "pay-ap2: jobId");
  const peerIdentity = input.peerIdentity;
  const expected = snapshotWireJsonRead(input.expectedProfile, "AP2 local profile") as Ap2CorrectiveProfile;
  if (typeof peerIdentity !== "string" || peerIdentity.length === 0 ||
      !exact(expected, ["releasePin", "moduleVersions"]) || !validProfile(expected)) {
    throw new DacsError("pay-ap2: invalid local profile policy");
  }
  if (modules.some((key) => expected.moduleVersions[key] !== AP2_IMPLEMENTED_MODULE_VERSIONS[key])) {
    throw new DacsError("pay-ap2: local profile names a module tuple this implementation does not implement");
  }
  const records = snapshotWireJsonRead(await authenticateParticipants.call(input), "AP2 authenticated participants") as Ap2ParticipantProfile[];
  if (!Array.isArray(records)) throw new DacsError("pay-ap2: invalid participant authority");
  const identities = new Set<string>();
  for (const record of records) {
    if (!record || !exact(record, ["jobId", "identity", "authenticated", "releasePin", "moduleVersions"]) ||
        !validProfile(record) || record.authenticated !== true || record.jobId !== jobId ||
        typeof record.identity !== "string" || record.identity.length === 0 || identities.has(record.identity) ||
        record.releasePin !== expected.releasePin || modules.some((key) => record.moduleVersions[key] !== expected.moduleVersions[key])) {
      throw new DacsError("pay-ap2: participant profile admission refused");
    }
    identities.add(record.identity);
  }
  if (!identities.has(peerIdentity)) throw new DacsError("pay-ap2: expected peer is not authenticated");
  const capability = Object.freeze({ kind: "ap2-profile-admission" as const });
  admitted.set(capability, { jobId, peerIdentity });
  return capability;
}

export function readAp2ProfileAdmission(input: unknown): Readonly<{
  jobId: string; phaseIndex: number; peerIdentity: string; profileAdmission: Ap2ProfileAdmission;
}> | undefined {
  try {
    if (!input || typeof input !== "object" || nodeTypes.isProxy(input)) return undefined;
    const values: Record<string, unknown> = {};
    for (const key of ["jobId", "phaseIndex", "peerIdentity", "profileAdmission"]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      values[key] = descriptor.value;
    }
    const jobId = requireCanonicalJobId(values.jobId, "pay-ap2: jobId");
    const scope = admitted.get(values.profileAdmission as Ap2ProfileAdmission);
    const phaseIndex = values.phaseIndex as number;
    if (!scope || scope.jobId !== jobId || scope.peerIdentity !== values.peerIdentity ||
        !Number.isSafeInteger(phaseIndex) || phaseIndex < 0 || Object.is(phaseIndex, -0)) return undefined;
    return Object.freeze({ jobId, phaseIndex, peerIdentity: scope.peerIdentity, profileAdmission: values.profileAdmission as Ap2ProfileAdmission });
  } catch { return undefined; }
}

export function hasAp2ProfileAdmission(input: unknown): boolean {
  return readAp2ProfileAdmission(input) !== undefined;
}
