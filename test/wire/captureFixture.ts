// Runtime validation precedes all capture-derived key maps and verdict calls.
import type { ListingPin } from "../../src/wire/index.js";
export type OriginalCapture = typeof import("./fixtures/plugin-wire-82bf8c4.original.json");
export type PreRevisionCapture = typeof import("./fixtures/plugin-wire-82bf8c4.tp1-adapted.json");
export type RevisionCapture = typeof import("./fixtures/plugin-wire-82bf8c4.tp1-revision-adapted.json");
export interface RequestCase {
  id?: string; header: string; bodyText?: string; requireDelegation?: boolean;
  server?: { seller?: string; listingPin?: ListingPin };
}
export interface DelegationCase {
  id?: string; delegation: unknown;
  scope: { seller?: string; listingPin?: ListingPin; jobId?: string; time?: number; deadline?: number };
}
export interface ResponseCase { id?: string; header: string; status: number; text: string }
export const captureRecord = (v: unknown, label = "record"): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`capture schema: ${label} must be an object`);
  return v as Record<string, unknown>;
};
const text = (v: unknown, label: string) => { if (typeof v !== "string") throw new Error(`capture schema: ${label} must be a string`); };
const array = (v: unknown, label: string): unknown[] => { if (!Array.isArray(v)) throw new Error(`capture schema: ${label} must be an array`); return v; };
const payload = (v: unknown) => { const p = captureRecord(v, "payload"); text(p.kind, "payload.kind"); if (p.profile !== undefined) captureRecord(p.profile, "profile"); };
function common(v: unknown, fixture: string): asserts v is OriginalCapture | PreRevisionCapture | RevisionCapture {
  const r = captureRecord(v, fixture);
  if (r.fixture !== fixture) throw new Error(`capture schema: expected ${fixture}`);
  text(r.nature, "nature");
  if (typeof r.now !== "number") throw new Error("capture schema: now must be numeric");
  const parties = captureRecord(r.parties, "parties"), job = captureRecord(r.job, "job");
  for (const role of ["buyer", "seller", "session", "other"]) text(parties[role], `parties.${role}`);
  for (const field of ["jobId", "otherJobId", "agreementHash", "path"]) text(job[field], `job.${field}`);
  for (const field of ["listingPin", "otherListingPin"]) {
    const pin = captureRecord(job[field], field); text(pin.listingId, "listingId"); text(pin.contentHash, "contentHash");
    if (typeof pin.version !== "number") throw new Error("capture schema: pin version must be numeric");
  }
  const valid = captureRecord(r.valid, "valid");
  for (const name of ["request", "response", "delegatedRequest", "delegation"]) {
    const c = captureRecord(valid[name], `valid.${name}`); payload(c.payload);
    if (name === "delegation") text(c.signature, "delegation.signature"); else text(c.header, `${name}.header`);
    if (name === "response") { payload(c.request); text(c.text, "response.text"); }
  }
  for (const name of ["requestNegatives", "delegationNegatives", "responseNegatives"]) {
    for (const value of array(r[name], name)) {
      const c = captureRecord(value, name); text(c.id, `${name}.id`);
      if (name === "delegationNegatives") { const d = captureRecord(c.delegation, "delegation"); payload(d.payload); text(d.signature, "signature"); captureRecord(c.scope, "scope"); }
      else text(c.header, `${name}.header`);
      if (name === "responseNegatives") { text(c.text, "response.text"); if (typeof c.status !== "number") throw new Error("capture schema: response status required"); }
    }
  }
}
export function parseCapture(value: unknown, variant: "original"): OriginalCapture;
export function parseCapture(value: unknown, variant: "pre-revision"): PreRevisionCapture;
export function parseCapture(value: unknown, variant: "revision"): RevisionCapture;
export function parseCapture(value: unknown, variant: "original" | "pre-revision" | "revision") {
  const suffix = { original: "original", "pre-revision": "tp1-adapted", revision: "tp1-revision-adapted" }[variant];
  common(value, `plugin-wire-82bf8c4.${suffix}`);
  if (variant === "original") {
    const provenance = captureRecord("provenance" in value ? value.provenance : undefined, "provenance");
    text(provenance.commit, "provenance.commit"); array(provenance.sources, "provenance.sources"); captureRecord(provenance.generator, "generator");
    array("rawInput" in value ? value.rawInput : undefined, "rawInput");
  } else {
    const r = captureRecord(value), identity = captureRecord(r.syntheticIdentityRecord, "syntheticIdentityRecord");
    text(identity.digest, "syntheticIdentityRecord.digest"); captureRecord(identity.record, "identity record");
    const bindings = captureRecord(r.localBindings, "localBindings");
    for (const role of ["buyer", "seller"]) captureRecord(bindings[role], `localBindings.${role}`);
    array(r.changes, "changes");
    if (variant === "revision") {
      const substitution = captureRecord(r.keySubstitution, "keySubstitution");
      const parties = captureRecord(substitution.parties, "keySubstitution.parties");
      for (const role of ["buyer", "seller", "session", "other"]) {
        const pair = captureRecord(parties[role], `keySubstitution.${role}`); text(pair.from, "from"); text(pair.to, "to");
      }
    }
  }
  return value;
}
