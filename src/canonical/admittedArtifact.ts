import { types as nodeTypes } from "node:util";
import { admitRawJson, type RawJsonAdmissionOptions } from "./rawJson.js";
import { snapshotWireJsonRead } from "./snapshot.js";
import { canonicalize } from "./jcs.js";
import { DacsError } from "../errors.js";

interface Admission { root: object; wire: string }
// One immutable wire snapshot per admission, shared by its object members.
const admitted = new WeakMap<object, Admission>();

function register(root: object): void {
  const proof = { root, wire: JSON.stringify(root) };
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    admitted.set(value, proof);
    for (const child of Object.values(value)) visit(child);
  };
  visit(root);
}

/** Admit exact external bytes, then optionally select an object envelope member. */
export function admitArtifactJson(
  bytes: Uint8Array,
  member?: string,
  options?: Readonly<RawJsonAdmissionOptions>,
): Record<string, unknown> {
  const root = admitRawJson(bytes, options);
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    throw new DacsError("admitted artifact must be a JSON object");
  }
  if (member !== undefined && (typeof member !== "string" || !Object.hasOwn(root, member))) {
    throw new DacsError("admitted artifact member is missing");
  }
  const value = member === undefined ? root : (root as Record<string, unknown>)[member];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DacsError("admitted artifact must be a JSON object");
  }
  register(root);
  return value as Record<string, unknown>;
}

/** Own an unchanged admitted record; snapshots retain runtime provenance. */
export function snapshotAdmittedArtifact(value: unknown): Record<string, unknown> {
  const proof = value !== null && typeof value === "object" ? admitted.get(value) : undefined;
  if (!proof) throw new DacsError("external artifact requires exact raw-byte admission");
  const root = snapshotWireJsonRead(proof.root, "admitted transport");
  if (JSON.stringify(root) !== proof.wire) {
    throw new DacsError("artifact changed after raw-byte admission");
  }
  if (Array.isArray(value)) throw new DacsError("admitted artifact must be a JSON object");
  const snapshot = snapshotWireJsonRead(value, "admitted artifact") as Record<string, unknown>;
  register(snapshot);
  return snapshot;
}

/**
 * Carry existing admission through an equivalent owned JSON snapshot. This
 * never grants provenance to parsed external data: an admitted source is
 * required, its original transport must be unchanged, and canonical values
 * must agree. Nested admitted records also survive construction of local DTOs.
 */
export function inheritArtifactAdmission(source: unknown, snapshot: unknown, seen = new WeakSet<object>()): void {
  if (source === null || typeof source !== "object" || nodeTypes.isProxy(source) ||
      snapshot === null || typeof snapshot !== "object" || nodeTypes.isProxy(snapshot) || seen.has(source)) return;
  seen.add(source);
  if (admitted.has(source)) {
    if (Array.isArray(source)) {
      // Arrays are traversed below; artifact capabilities are object records.
    } else {
      const original = snapshotAdmittedArtifact(source);
      if (canonicalize(original) !== canonicalize(snapshot)) {
        throw new DacsError("snapshot changed admitted artifact values");
      }
      register(snapshot);
      return;
    }
  }
  const prototype = Object.getPrototypeOf(source);
  if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) return;
  for (const key of Object.keys(source)) {
    const from = Object.getOwnPropertyDescriptor(source, key);
    const to = Object.getOwnPropertyDescriptor(snapshot, key);
    if (from && to && "value" in from && "value" in to) {
      inheritArtifactAdmission(from.value, to.value, seen);
    }
  }
}

/** Clone local JSON DTOs while retaining any existing admitted artifact members. */
export function cloneWithArtifactAdmission<T>(value: T): T {
  const snapshot = structuredClone(value);
  inheritArtifactAdmission(value, snapshot);
  return snapshot;
}
