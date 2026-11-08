// Private four-node rig, inert until an explicit, source-pinned selection.
import { canonicalize } from "../canonical/jcs.js";
import { sha256Hex } from "../canonical/hash.js";
import type { LocalNetworkBinding, Tp1AuthorityReader, Tp1WireProfileShape } from "./profile.js";
import { deepFreeze, fail, hasKeys, HASH, isClaim, isRecord, ownedArtifact, ownedConfig, ownedFields, uncurry, WireError } from "./validate.js";

export const RIG_IDENTITY_RECORD = deepFreeze({
  format: "dacs-rig-identity-record/v1",
  recordId: "dacs-demos-rig-identity/2026-11-08",
  network: "demos-rig",
  profile: { id: "dacs-rig-tp1", revision: "TP-1", base: "d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20" },
  chainIdentity: "26f74217d02edb713bb2affb694a5ad38c40e0edaf71c793c75321f42c1f6e71",
  genesisFileSha256: "5444bfbe73018e31c40a964da577c9a75ebb85e42d03b3db64094c3b0e47a721",
  pinVersion: "dacs-demos-rig-identity/2026-11-08",
  sourceKind: "confirmed-block-one-predecessor",
  documentation: "The private four-node rig refuses numeric block 0. Its chain identity is confirmed block 1's content.previousHash, independently checked against dacs-demos-rig-identity/2026-11-08. The genesis file digest is operator provenance; each run separately pins block 2.",
  deployment: {
    commit: "e6af8f4023fa4e77f482503dae97f1ca00834bf9", dirty: false,
    artifactSha256: null as string | null,
    qualifiedOperations: ["fee", "nonce", "broadcast", "confirmation"],
  },
} as const);
// The incomplete seed is never hashed as approval. Replace both nulls only
// after the operator supplies the image digest and the complete JCS is reviewed.
export const RIG_RECORD_SHA256: string | null = null;
export const rigDeploymentPin = () => RIG_IDENTITY_RECORD.deployment;
export interface RigSelection {
  readonly recordSha256: string;
  readonly runBlockTwoHash: string;
}
export interface RigWireProfile extends Tp1WireProfileShape {
  id: "dacs-rig-tp1";
  revision: "TP-1";
  base: "d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20";
}
let selected: Readonly<RigSelection> | undefined;
let pendingTp1 = 0, boundTp1 = false;
export const rigProfileSelected = (): boolean => selected !== undefined;

/** Internal TP-1 reservation: acquired before any await, released in finally. */
export function reserveTp1Binding(): (succeeded: boolean) => void {
  if (selected) fail("rig_selected", 500);
  pendingTp1++;
  return (succeeded) => { pendingTp1--; boundTp1 ||= succeeded; };
}
function requireSelection(selection: unknown): asserts selection is Readonly<RigSelection> {
  if (!selected || selection !== selected) fail("rig_selection_required", 500);
}
export function selectRigProfile(options: { recordSha256: string; acknowledgement: string; runBlockTwoHash: string }): Readonly<RigSelection> {
  if (selected) fail("rig_already_selected", 500);
  if (pendingTp1 || boundTp1) fail("tp1_binding_active", 500);
  if (!hasKeys(options, ["recordSha256", "acknowledgement", "runBlockTwoHash"])) fail("rig_selection_invalid", 500);
  const copy = ownedConfig(options, "rig_selection_invalid") as Record<string, unknown>;
  if (copy.acknowledgement !== "PRIVATE FOUR-NODE RIG ONLY" || typeof copy.recordSha256 !== "string" || !HASH.test(copy.recordSha256) ||
      typeof copy.runBlockTwoHash !== "string" || !HASH.test(copy.runBlockTwoHash)) fail("rig_selection_invalid", 500);
  if (RIG_RECORD_SHA256 === null || RIG_IDENTITY_RECORD.deployment.artifactSha256 === null) fail("rig_record_incomplete", 500);
  if (!HASH.test(RIG_IDENTITY_RECORD.deployment.artifactSha256) || copy.recordSha256 !== RIG_RECORD_SHA256 ||
      sha256Hex(canonicalize(RIG_IDENTITY_RECORD)) !== RIG_RECORD_SHA256) fail("rig_selection_invalid", 500);
  selected = deepFreeze({ recordSha256: copy.recordSha256, runBlockTwoHash: copy.runBlockTwoHash });
  return selected;
}

interface SourceEntry {
  selection: Readonly<RigSelection>;
  pins: Record<string, unknown>;
  policy: unknown;
  observe: () => unknown;
  buyer: string;
  seller: string;
}
const sources = new WeakMap<object, SourceEntry>();
const getSource = uncurry(WeakMap.prototype.get) as (map: typeof sources, key: object) => SourceEntry | undefined;
const setSource = uncurry(WeakMap.prototype.set) as (map: typeof sources, key: object, value: SourceEntry) => unknown;
const SOURCE_FIELDS = ["pins", "demoArtifactPublication", "settlementPublication", "deliveryPublication", "transportBinding", "observeBinding", "runBlockTwoHash"] as const;
function sourceFields(source: unknown) { return ownedFields(source, SOURCE_FIELDS); }
const sourceBindingId = (pins: Record<string, unknown>) => sha256Hex(JSON.stringify(["dacs-demos-network-binding/v1",
  ...["network", "chainIdentity", "pinVersion", "endpoint", "transportAuthority"].map(k => pins[k])]));
const publicationFields = (fields: Record<string, unknown>) => ownedArtifact({ demo: fields.demoArtifactPublication,
  settlement: fields.settlementPublication, delivery: fields.deliveryPublication, declaration: fields.transportBinding }, "rig_source_invalid", 500) as Record<string, unknown>;
function checkedPins(value: unknown): Record<string, unknown> {
  const pins = ownedArtifact(value, "rig_source_invalid", 500);
  if (!hasKeys(pins, ["network", "chainIdentity", "pinVersion", "endpoint", "transportAuthority"]) ||
      pins.chainIdentity !== RIG_IDENTITY_RECORD.chainIdentity) fail("identity_mismatch", 500);
  if (pins.network !== RIG_IDENTITY_RECORD.network || pins.pinVersion !== RIG_IDENTITY_RECORD.pinVersion) fail("rig_source_invalid", 500);
  let url: URL;
  try { url = new URL(typeof pins.endpoint === "string" ? pins.endpoint : ""); } catch { return fail("rig_source_invalid", 500); }
  if (url.href !== pins.endpoint || url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search || url.hash ||
      typeof pins.transportAuthority !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(pins.transportAuthority)) fail("rig_source_invalid", 500);
  return pins;
}
/** Trusted operator integration; labels alone never create source membership. */
export function installRigSource(options: { selection: RigSelection; source: object; buyer: string; seller: string }): void {
  const { selection, source, buyer, seller } = ownedFields(options, ["selection", "source", "buyer", "seller"]);
  requireSelection(selection);
  if (!isRecord(source) || getSource(sources, source) || !isClaim(buyer) || !isClaim(seller) || buyer === seller) fail("rig_source_invalid", 500);
  const fields = sourceFields(source), pins = checkedPins(fields.pins);
  const policies = publicationFields(fields), policy = policies.demo, settlement = policies.settlement, delivery = policies.delivery;
  if (typeof fields.observeBinding !== "function" || fields.runBlockTwoHash !== selection.runBlockTwoHash ||
      !hasKeys(policy, ["artifactKinds", "authority", "policy"]) || policy.policy !== "dacs-devnet-demo-artifacts/v1" ||
      typeof policy.authority !== "string" || !/^TEST-RUN-rig-[A-Za-z0-9._-]{8,76}$/.test(policy.authority) ||
      canonicalize(policy.artifactKinds) !== canonicalize(["CompositeVerificationRecord", "Deliverable", "FinalityCommitmentRecord", "Listing", "SettlementEvidence"])) fail("rig_source_invalid", 500);
  if (!hasKeys(settlement, ["artifactKind", "authority", "phase", "phaseIndex", "policy", "railId"]) || settlement.artifactKind !== "SettlementEvidence" ||
      settlement.authority !== policy.authority || settlement.phase !== "pay-dem" || settlement.phaseIndex !== 2 || settlement.railId !== "demos-native:DEM" ||
      settlement.policy !== "dacs-native-settlement-publication/v1" || !hasKeys(delivery, ["artifactKind", "authority", "phase", "phaseIndex", "policy"]) ||
      delivery.artifactKind !== "Deliverable" || delivery.authority !== policy.authority || delivery.phase !== "deliver-storage-program" ||
      !Number.isSafeInteger(delivery.phaseIndex) || (delivery.phaseIndex as number) < 0 || delivery.policy !== "dacs-native-delivery-publication/v1") fail("rig_source_invalid", 500);
  if (canonicalize(policies.declaration) !== canonicalize({ source: "devnet-agreement-transport/v1", bindingVersion: "dacs-demos-network-binding/v1",
    bindingId: sourceBindingId(pins), ...pins, settlementPublication: settlement, deliveryPublication: delivery, demoArtifactPublication: policy })) fail("rig_source_invalid", 500);
  setSource(sources, source, { selection, pins: deepFreeze(pins), policy: deepFreeze(policies), observe: fields.observeBinding as () => unknown, buyer, seller });
}
export function isRigSource(source: unknown): boolean {
  if (!selected || !isRecord(source)) return false;
  const entry = getSource(sources, source);
  if (!entry || entry.selection !== selected) return false;
  try {
    const fields = sourceFields(source);
    return fields.observeBinding === entry.observe && fields.runBlockTwoHash === selected.runBlockTwoHash &&
      canonicalize(ownedArtifact(fields.pins, "rig_source_invalid", 500)) === canonicalize(entry.pins) &&
      canonicalize(publicationFields(fields)) === canonicalize(entry.policy);
  } catch { return false; }
}
async function observeSource(entry: SourceEntry, source: unknown): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => entry.observe.call(source)), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new WireError("rig_connection_unverified", 500)), 10000);
    })]);
  } finally { clearTimeout(timer); }
}
/** Internal reader: only this module's selected source can supply authority. */
export function rigAuthorityReader(selection: unknown, source: unknown, local: LocalNetworkBinding, profile: RigWireProfile,
  modules: unknown): Tp1AuthorityReader {
  requireSelection(selection);
  if (!isRigSource(source)) fail("rig_source_required", 500);
  const entry = getSource(sources, source as object)!;
  const bindingId = sourceBindingId(entry.pins);
  return async scope => {
    if (!isRigSource(source)) fail("rig_source_required", 500);
    if (scope.participants.some(claim => claim !== entry.buyer && claim !== entry.seller)) fail("tp1_participant_profile_mismatch", 500);
    const observation = ownedArtifact(await observeSource(entry, source), "rig_connection_unverified", 500);
    if (!isRecord(observation) || observation.chainIdentity !== RIG_IDENTITY_RECORD.chainIdentity) fail("identity_mismatch", 500);
    const now = Date.now();
    if (!isRigSource(source) || observation.bindingVersion !== "dacs-demos-network-binding/v1" || observation.bindingId !== bindingId ||
        Object.keys(entry.pins).some(k => observation[k] !== entry.pins[k]) || observation.endpoint !== local.endpoint ||
        observation.transportAuthority !== local.transportAuthority || observation.connectionId !== local.connectionId ||
        !isRecord(observation.source) || observation.source.kind !== RIG_IDENTITY_RECORD.sourceKind || observation.source.blockNumber !== 1 ||
        typeof observation.source.blockHash !== "string" || !HASH.test(observation.source.blockHash) || observation.source.fallbackDocumentation !== RIG_IDENTITY_RECORD.documentation ||
        !Number.isSafeInteger(observation.observedAt) || !Number.isSafeInteger(observation.expiresAt) ||
        (observation.observedAt as number) > now || (observation.expiresAt as number) <= now ||
        (observation.expiresAt as number) - (observation.observedAt as number) > 60000) fail("rig_connection_unverified", 500);
    return { local: { ...local }, chainIdentity: observation.chainIdentity, provenance: `rig:${sha256Hex(canonicalize({ bindingId, local }))}`,
      sessionId: scope.sessionId, participants: scope.participants.map(claim => ({ claim, profile: { ...profile }, modules })) };
  };
}
