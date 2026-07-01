/**
 * CCI (Cross-Context Identity) — the DACS-1 Identify layer.
 *
 * A Demos identity is more than the wallet key: the ed25519 public key is the
 * *primary claim* (the DID root), and the on-chain GCR binds *linked claims* to
 * it — Web2 handles (X / GitHub / Discord / Telegram) and cross-chain wallets
 * ("<chainType>:<address>"). The SDK used to see only the primary key; this
 * module resolves the whole record so an agent can be identified/vetted by any
 * of its claims.
 *
 * `parseCciRecord` is pure over the substrate's raw identity payload (so it's
 * unit-tested without a node); the DemosAdapter feeds it what the GCR routine
 * returns. It reads the confirmed shape the Demos identity graph exposes
 * (`linkedSocials` + `linkedWallets`) and is tolerant of the RPC envelope
 * nesting; anything not modelled stays available on `raw`.
 */

/** Claim families beyond the primary key. */
export type CciClaimKind = "web2" | "wallet";

/** A linked Web2 handle (X / GitHub / Discord / Telegram / …). */
export interface CciWeb2Claim {
  kind: "web2";
  /** Platform, e.g. "twitter" | "github" | "discord" | "telegram". */
  platform: string;
  /** The claimed handle/username. */
  handle: string;
  /** Canonical claim ref: `web2:<platform>:<handle>`. */
  ref: string;
}

/** A linked cross-chain wallet (an XM identity). */
export interface CciWalletClaim {
  kind: "wallet";
  /** Chain family, e.g. "evm" | "solana" | "ton" | "near". */
  chainType: string;
  /** The on-chain address. */
  address: string;
  /** Canonical claim ref: `xm:<chainType>:<address>`. */
  ref: string;
}

export type CciClaim = CciWeb2Claim | CciWalletClaim;

/** A resolved cross-context identity record for a subject. */
export interface CciRecord {
  /** The subject's primary claim — the Demos ed25519 public-key hex / DID root. */
  primaryClaim: string;
  /** Linked Web2 handles. */
  web2: CciWeb2Claim[];
  /** Linked cross-chain wallets. */
  wallets: CciWalletClaim[];
  /** All linked claims (web2 ++ wallets), for convenience. */
  claims: CciClaim[];
  /** The raw substrate payload, for anything not yet modelled. */
  raw: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The GCR identity graph can arrive wrapped in RPC envelopes (`{ response: {
 * response: {...} } }`, `{ data: {...} }`, …). Walk a few known wrappers to find
 * the object that actually carries the identity fields.
 */
function unwrapIdentityPayload(raw: unknown): Record<string, unknown> {
  let cur: unknown = raw;
  for (let i = 0; i < 5 && isObj(cur); i++) {
    const o = cur as Record<string, unknown>;
    if ("linkedWallets" in o || "linkedSocials" in o) return o;
    if (isObj(o.response)) cur = o.response;
    else if (isObj(o.data)) cur = o.data;
    else break;
  }
  return isObj(cur) ? cur : {};
}

function parseWeb2(payload: Record<string, unknown>): CciWeb2Claim[] {
  const socials = payload["linkedSocials"];
  if (!isObj(socials)) return [];
  const out: CciWeb2Claim[] = [];
  for (const [platform, value] of Object.entries(socials)) {
    if (typeof value !== "string") continue;
    const handle = value.trim();
    if (!handle) continue;
    out.push({ kind: "web2", platform, handle, ref: `web2:${platform}:${handle}` });
  }
  return out;
}

function parseWallets(payload: Record<string, unknown>): CciWalletClaim[] {
  const linked = payload["linkedWallets"];
  if (!Array.isArray(linked)) return [];
  const out: CciWalletClaim[] = [];
  for (const entry of linked) {
    if (typeof entry !== "string") continue;
    // Entries are "<chainType>:<address>" — the address itself may contain ":"
    // (unlikely for the supported chains, but split once to be safe).
    const idx = entry.indexOf(":");
    if (idx <= 0) continue;
    const chainType = entry.slice(0, idx);
    const address = entry.slice(idx + 1);
    if (!address) continue;
    out.push({
      kind: "wallet",
      chainType,
      address,
      ref: `xm:${chainType}:${address}`,
    });
  }
  return out;
}

/**
 * Parse a raw GCR identity payload into a structured {@link CciRecord}.
 * `primaryClaim` is the subject's canonical claim (the ed25519 pubkey hex / DID
 * the caller resolved) — it's carried through as the record's root.
 */
export function parseCciRecord(primaryClaim: string, raw: unknown): CciRecord {
  const payload = unwrapIdentityPayload(raw);
  const web2 = parseWeb2(payload);
  const wallets = parseWallets(payload);
  return {
    primaryClaim,
    web2,
    wallets,
    claims: [...web2, ...wallets],
    raw,
  };
}

/** Every claim ref for a record, primary first. */
export function cciClaimRefs(record: CciRecord): string[] {
  return [record.primaryClaim, ...record.claims.map((c) => c.ref)];
}

/**
 * Does the record assert `ref`? Matches the primary claim or any linked claim.
 * Web2 refs match case-insensitively (handles/platforms aren't case-sensitive);
 * wallet/primary refs match exactly.
 */
export function cciHasClaim(record: CciRecord, ref: string): boolean {
  if (ref === record.primaryClaim) return true;
  const lower = ref.toLowerCase();
  return record.claims.some((c) =>
    c.kind === "web2" ? c.ref.toLowerCase() === lower : c.ref === ref,
  );
}
