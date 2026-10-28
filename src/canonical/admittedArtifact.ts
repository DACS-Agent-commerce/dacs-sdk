import { admitRawJson, type RawJsonAdmissionOptions } from "./rawJson.js";
import { snapshotWireJsonRead } from "./snapshot.js";
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
  // Raw-token validation must precede JSON's permitted -0 -> 0 projection.
  // This owns the parsed tree without changing wire keys or string values.
  const root: unknown = JSON.parse(JSON.stringify(admitRawJson(bytes, options)));
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
