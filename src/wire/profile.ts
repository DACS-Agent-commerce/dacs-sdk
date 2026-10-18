// Testnet profile TP-1 and the network identity gate in front of every wire
// signature.
//
// The immutable Demos testnet identity record was approved on 2026-10-15
// at 16:41Z. Approval is held in SDK source
// (./approval.ts) and never taken from the caller. No network label, fixture
// constant or value observed from an RPC can stand in for it.
import { canonicalize } from "../canonical/jcs.js";
import { sha256Hex } from "../canonical/hash.js";
import { TP1_APPROVED_IDENTITY_RECORD_DIGESTS } from "./approval.js";
import { DACS_SELLER_DISCOVERY_PATH, DACS_SELLER_HTTP_V1 } from "./routes.js";
import { deepFreeze, fail, hasKeys, HASH, isRecord, ownedArtifact, ownedConfig, ownedFields, ownedOrNothing, uncurry } from "./validate.js";

export const TP1_PROFILE_ID = "dacs-testnet-tp1";
/** The profile revision. Each later revision (TP-1.1, ...) is a new value with its own base. */
export const TP1_PROFILE_REVISION = "TP-1";
/** The profile revisions this SDK defines. A received revision is compared exactly: any other value is unknown. */
export const TP1_PROFILE_REVISIONS: readonly string[] = Object.freeze([TP1_PROFILE_REVISION]);
/** DACS-Standard `next` d45c0a2: TP-1's proposed reference revision and the SDK's vector pin. */
export const TP1_BASE_REVISION = "d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20";
export const TP1_DECLARATION = "experimental testnet implementation; not a conformant live DACS profile";

/** What a TP-1 seller sells and how it delivers it. Discovery states exactly this. */
export const TP1_CAPABILITIES = deepFreeze({
  capability: "FP-DEM",
  negotiation: ["negotiate-fixed-price"],
  rails: ["pay-dem"],
  identityScheme: "did:demos:agent",
  delivery: { channel: "demos-storage", address: "dacs4:deliverable:{jobId}" },
  services: ["fixed-text", "pure-synchronous-text-module"],
  output: {
    envelope: "dacs-chatgpt-plugin/devnet-purchased-report",
    reportVersion: "1",
    mediaType: "text/plain; charset=utf-8",
    maxCharacters: 16384,
    synchronous: true,
  },
  buyerRequestInput: false,
});

export const TP1_IDENTITY_RECORD_FORMAT = "dacs-testnet-identity-record/v1";

/**
 * SHA-256 of canonical identity records approved for TP-1 (./approval.ts).
 * The approved record includes its source kind and fallback documentation.
 * bindTp1Profile reads this list itself: a caller cannot supply or extend it.
 */
export { TP1_APPROVED_IDENTITY_RECORD_DIGESTS };

/**
 * Chain identities refused even if a record naming them were approved, for
 * example a known mainnet identity. Empty until a dated approval names any; a caller may
 * add refusals (BindTp1Options.refusedChainIdentities) but never remove these.
 */
export const TP1_REFUSED_CHAIN_IDENTITIES: readonly string[] = Object.freeze([]);

/**
 * Simulated-fixture chain identities that must never be used as a live pin.
 * The buyer plugins' DACS_STORAGE_ANCHOR_CHAIN_IDENTITY is SHA-256 of this
 * fixture string; it is derived here to refuse it.
 */
export const TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES: readonly string[] = Object.freeze([
  sha256Hex("dacs-chatgpt-plugin/demos-sr2-sdk-wire-fixture/v1"),
]);

/** SDK representation of the approved record; actor-local fields are excluded. */
export const TP1_APPROVED_IDENTITY_RECORD = deepFreeze({
  format: "dacs-testnet-identity-record/v1",
  recordId: "dacs-demos-testnet-identity/2026-10-15",
  network: "demos-testnet",
  chainIdentity: "83082fbb733d76475a33a9f52fe3700d667a976c2d46bef33a149f47057f7dd4",
  pinVersion: "dacs-demos-testnet-identity/2026-10-15",
  provenance: {
    approvedBy: "the owner",
    approvedAt: "2026-10-15T16:41:00Z",
    source: "Approved Demos testnet identity record (2026-10-15T16:41:00Z)",
    sourceKind: "confirmed-block-one-predecessor",
    documentation: "Demos testnet nodes do not serve block 0 (`getBlockByNumber` 0 returns 400). The chain identity is block 1's `content.previousHash`, checked against the approved record `dacs-demos-testnet-identity/2026-10-15`.",
  },
} satisfies TestnetIdentityRecord);

export const TESTNET_PROFILE_TP1 = deepFreeze({
  id: TP1_PROFILE_ID,
  revision: TP1_PROFILE_REVISION,
  status: "proposed; composition qualification pending",
  declaration: TP1_DECLARATION,
  relationToStandard: "SDK declaration of the SDK's testnet release; it does not change or extend the DACS Standard",
  base: {
    repo: "DACS-Standard",
    ref: "next",
    commit: TP1_BASE_REVISION,
    status: "proposed reference revision; composition qualification pending",
  },
  // spec/PROFILE.md:43-50 at d45c0a2.
  tuple: { CORE: "0.3", "DACS-1": "0.7", "DACS-2": "0.6", "DACS-3": "0.5", "DACS-4": "0.8", "DACS-5": "0.5" },
  network: {
    scope: "Demos testnet only; the wire refuses unapproved identities before signing",
    composition: "Intended TP-1 composition: refuse unapproved identities before broadcasts; retained seller, browser and stdio effect paths are not connected to this gate and broadcast refusal is not checked",
    identityRecord: TP1_APPROVED_IDENTITY_RECORD,
    identityRecordFormat: TP1_IDENTITY_RECORD_FORMAT,
    approvedIdentityRecordDigests: TP1_APPROVED_IDENTITY_RECORD_DIGESTS,
    refusedChainIdentities: TP1_REFUSED_CHAIN_IDENTITIES,
    status: "record approved on 2026-10-15 at 16:41Z pinned; composition qualification remains pending",
  },
  capabilities: TP1_CAPABILITIES,
  wire: { transport: DACS_SELLER_HTTP_V1, discoveryPath: DACS_SELLER_DISCOVERY_PATH },
  identityBinding: {
    tuple: ["id", "revision", "base"],
    rule: "Every discovery document and signed request, response and delegation carries the profile identifier, profile revision and full base commit inside its signed bytes. Each party requires an exact match with the tuple it selected locally and with the tuple kept for that purchase; a missing, unknown or mismatched value is refused before any effect, with no fallback to identifier and base alone.",
    status: "approved on 2026-10-15 at 21:23Z, as proposed",
  },
  claims: "did:demos:agent:<64 lowercase hex>",
});

/** the approved record, supplied by the integrator; never derived from an RPC. */
export interface TestnetIdentityRecord {
  format: typeof TP1_IDENTITY_RECORD_FORMAT;
  recordId: string;
  network: "demos-testnet";
  chainIdentity: string;
  pinVersion: string;
  provenance: {
    approvedBy: string;
    approvedAt: string;
    source: string;
    /** the approved record's fallback carries both fields; older synthetic fixtures omit both. */
    sourceKind?: "confirmed-block-one-predecessor";
    documentation?: string;
  };
}

/**
 * The profile field every signed request, response, delegation and discovery
 * document carries: the tuple (identifier, revision, base) and the approved record's pins.
 */
export interface Tp1WireProfile {
  id: typeof TP1_PROFILE_ID;
  revision: typeof TP1_PROFILE_REVISION;
  base: typeof TP1_BASE_REVISION;
  chainIdentity: string;
  pinVersion: string;
}
export const TP1_WIRE_PROFILE_KEYS = ["id", "revision", "base", "chainIdentity", "pinVersion"] as const;

/** One actor's own connection. It never travels on the wire. */
export interface LocalNetworkBinding {
  endpoint: string;
  transportAuthority: string;
  connectionId: string;
}

export interface Tp1Binding {
  readonly profile: Readonly<Tp1WireProfile>;
  readonly recordDigest: string;
  readonly local: Readonly<LocalNetworkBinding>;
  readonly localDigest: string;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const isIdentifier = (v: unknown): v is string => typeof v === "string" && IDENTIFIER.test(v);
// The bindings bindTp1Profile made. Membership is the only proof of a binding:
// a copied object, field or tag is not in this set. The methods are taken at
// module load, so patching Array or WeakSet prototypes later changes nothing.
const bindings = new WeakSet<object>();
const listHas = uncurry(Array.prototype.includes) as (list: readonly string[], value: string) => boolean;
const isBinding = uncurry(WeakSet.prototype.has) as (set: WeakSet<object>, value: object) => boolean;
const addBinding = uncurry(WeakSet.prototype.add) as (set: WeakSet<object>, value: object) => WeakSet<object>;

export interface BindTp1Options {
  /** the approved record, supplied independently of the endpoint. */
  record: unknown;
  /** More chain identities to refuse, on top of the SDK's own lists. It can never approve or un-refuse one. */
  refusedChainIdentities?: readonly string[];
  /** This actor's own endpoint, transport authority and connection. */
  local: unknown;
}

function localBinding(supplied: unknown): LocalNetworkBinding {
  const local = ownedConfig(supplied, "tp1_local_binding_invalid");
  if (!hasKeys(local, ["endpoint", "transportAuthority", "connectionId"])) return fail("tp1_local_binding_invalid", 500);
  let url: URL | null = null;
  try { url = new URL(String(local.endpoint)); } catch { /* refused below */ }
  if (typeof local.endpoint !== "string" || url === null || url.href !== local.endpoint || url.protocol !== "https:" ||
      url.username || url.password || url.search || url.hash ||
      !isIdentifier(local.transportAuthority) || !isIdentifier(local.connectionId)) {
    return fail("tp1_local_binding_invalid", 500);
  }
  return { endpoint: local.endpoint, transportAuthority: local.transportAuthority, connectionId: local.connectionId };
}

/**
 * The only public way to obtain a Tp1Binding, and every wire signer requires
 * one. The record must be approved by the SDK's own
 * TP1_APPROVED_IDENTITY_RECORD_DIGESTS, never by the
 * caller. Order: options read once (ownedFields), record present, one owned
 * data-only copy, pins present, schema, fixture identity, refused identity,
 * approval. Every check, the approval digest and the bound profile read that
 * one copy, never the caller's object again. A label such as "testnet" never
 * authorizes anything.
 */
export function bindTp1Profile(options: BindTp1Options): Tp1Binding {
  const { record: supplied, refusedChainIdentities: suppliedRefused = [], local: suppliedLocal } = ownedFields(options, ["record", "refusedChainIdentities", "local"]);
  const refusedChainIdentities = ownedConfig(suppliedRefused, "wire_input_invalid");
  if (!Array.isArray(refusedChainIdentities)) return fail("wire_input_invalid", 500);
  if (supplied === undefined || supplied === null) return fail("tp1_identity_record_missing", 500);
  const record = ownedConfig(supplied, "tp1_identity_record_invalid");
  if (!isRecord(record)) return fail("tp1_identity_record_invalid", 500);
  if (record.chainIdentity === undefined || record.chainIdentity === null || record.pinVersion === undefined || record.pinVersion === null) {
    return fail("tp1_identity_pin_missing", 500);
  }
  if (!hasKeys(record, ["format", "recordId", "network", "chainIdentity", "pinVersion", "provenance"]) ||
      record.format !== TP1_IDENTITY_RECORD_FORMAT || !isIdentifier(record.recordId) || record.network !== "demos-testnet" ||
      typeof record.chainIdentity !== "string" || !HASH.test(record.chainIdentity) || !isIdentifier(record.pinVersion) ||
      !(hasKeys(record.provenance, ["approvedBy", "approvedAt", "source"]) ||
        (hasKeys(record.provenance, ["approvedBy", "approvedAt", "source", "sourceKind", "documentation"]) &&
          record.provenance.sourceKind === "confirmed-block-one-predecessor")) ||
      !Object.values(record.provenance).every((v) => typeof v === "string" && v.length > 0 && v.length <= 512)) {
    return fail("tp1_identity_record_invalid", 500);
  }
  if (listHas(TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES, record.chainIdentity)) return fail("tp1_identity_fixture", 500);
  if (listHas(TP1_REFUSED_CHAIN_IDENTITIES, record.chainIdentity) || listHas(refusedChainIdentities, record.chainIdentity)) {
    return fail("tp1_identity_refused", 500);
  }
  const recordDigest = sha256Hex(canonicalize(record));
  if (!listHas(TP1_APPROVED_IDENTITY_RECORD_DIGESTS, recordDigest)) return fail("tp1_identity_unapproved", 500);
  const local = localBinding(suppliedLocal);
  const binding: Tp1Binding = deepFreeze({
    profile: { id: TP1_PROFILE_ID, revision: TP1_PROFILE_REVISION, base: TP1_BASE_REVISION, chainIdentity: record.chainIdentity, pinVersion: record.pinVersion },
    recordDigest,
    local,
    localDigest: sha256Hex(canonicalize(local)),
  });
  addBinding(bindings, binding);
  return binding;
}

/** Only an object bindTp1Profile returned. */
const isTp1Binding = (binding: unknown): binding is Tp1Binding =>
  typeof binding === "object" && binding !== null && isBinding(bindings, binding);

/**
 * Called first by every wire signer and every wire verifier. The binding must
 * come from bindTp1Profile, and the actor's current connection must be the one
 * it was bound with (each actor's own local fence; peers may use other RPCs).
 */
export function assertTp1Binding(binding: unknown, currentLocal: unknown): asserts binding is Tp1Binding {
  if (!isTp1Binding(binding)) fail("tp1_binding_required", 500);
  const local = localBinding(currentLocal);
  if (sha256Hex(canonicalize(local)) !== (binding as Tp1Binding).localDigest) fail("tp1_local_binding_changed", 500);
}

const profileShape = (v: unknown): v is Tp1WireProfile =>
  hasKeys(v, TP1_WIRE_PROFILE_KEYS) && isIdentifier(v.id) && isIdentifier(v.revision) && typeof v.base === "string" && /^[0-9a-f]{40}$/.test(v.base) &&
  typeof v.chainIdentity === "string" && HASH.test(v.chainIdentity) && isIdentifier(v.pinVersion);

/**
 * Shape only, of one owned copy (a Proxy or accessor is not a profile): a
 * well-formed profile naming another profile, revision, base, chain or
 * identity pin passes here and is refused by assertPeerProfile.
 */
export const isTp1WireProfile = (v: unknown): v is Tp1WireProfile => profileShape(ownedOrNothing(v));

/**
 * A received profile must equal the receiver's own bound profile: same TP-1
 * identifier, revision, base pin, chain identity and identity pin. Endpoints
 * are not compared; two parties may use different RPCs for the same approved
 * chain. `own` must be a binding from bindTp1Profile; an object that only
 * carries a profile is refused. The received profile is copied once and the
 * copy compared. Order: no profile; no revision (a profile of identifier and
 * base alone is never admitted); a revision this SDK does not define, compared
 * exactly, so case, whitespace and type variants are unknown; any other
 * difference. A caller that goes on to sign must sign from its own copy too.
 */
export function assertPeerProfile(received: unknown, own: Tp1Binding, status = 409): void {
  if (!isTp1Binding(own)) fail("tp1_binding_required", 500);
  if (received === undefined) fail("tp1_profile_missing", status);
  const profile = ownedArtifact(received, "tp1_profile_mismatch", status);
  if (isRecord(profile) && !Object.hasOwn(profile, "revision")) fail("tp1_profile_revision_missing", status);
  if (isRecord(profile) && !listHas(TP1_PROFILE_REVISIONS, profile.revision as string)) fail("tp1_profile_revision_unknown", status);
  if (!profileShape(profile) || canonicalize(profile) !== canonicalize(own.profile)) fail("tp1_profile_mismatch", status);
}

/**
 * The tuple an actor kept for a purchase must be exactly its own bound
 * profile, and so exactly the profile of every message it signs or accepts
 * for that purchase. A purchase kept under another identifier, revision, base
 * or identity, under a profile without a revision, or with no tuple at all is
 * refused before any effect. `own` must be a binding from bindTp1Profile; the
 * kept tuple is copied once and the copy compared.
 */
export function assertPurchaseProfile(kept: unknown, own: Tp1Binding, status = 409): void {
  if (!isTp1Binding(own)) fail("tp1_binding_required", 500);
  const copy = ownedOrNothing(kept);
  if (!profileShape(copy) || canonicalize(copy) !== canonicalize(own.profile)) fail("tp1_purchase_profile_mismatch", status);
}
