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

import { domainToASCII } from "node:url";
import { isIP } from "node:net";

/** Claim families beyond the primary key. */
export type CciClaimKind = "web2" | "wallet" | "ud" | "pqc";

/** A linked Web2 handle (X / GitHub / Discord / Telegram / a DNS `domain` / …). */
export interface CciWeb2Claim {
  kind: "web2";
  /** Platform, e.g. "twitter" | "github" | "discord" | "telegram" | "domain". */
  platform: string;
  /** The claimed handle/username. */
  handle: string;
  /**
   * Canonical claim ref: `web2:<platform>:<handle>` — except a DNS `domain`
   * identity, which emits the canonical DACS form `domain:<lowercase-idna-host>`.
   */
  ref: string;
  /**
   * The proof the node verified before writing this claim (a `/.well-known`
   * URL or a proof hash), when the GCR carries one. Its presence is evidence
   * the binding was attested; absent for legacy/flat entries.
   */
  proof?: string;
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

/** A linked Unstoppable Domain (a `ud` identity). */
export interface CciUdClaim {
  kind: "ud";
  /** The UD domain, e.g. "alice.crypto". */
  domain: string;
  /** The registry network the domain lives on, when known (e.g. "polygon"). */
  network?: string;
  /** Canonical claim ref: `cci-ud:<domain>` (DACS-1 §6.3 scheme registry). */
  ref: string;
  /** Ownership proof/signature evidence, when the GCR carries one. */
  proof?: string;
}

/** A linked post-quantum public key (a `pqc` identity). */
export interface CciPqcClaim {
  kind: "pqc";
  /** PQC scheme, e.g. "falcon" | "ml-dsa". */
  algorithm: string;
  /** The PQC public key / address. */
  address: string;
  /** Canonical claim ref: `cci-pqc:<algorithm>:<address>` (DACS-1 §6.3 scheme registry). */
  ref: string;
}

export type CciClaim =
  | CciWeb2Claim
  | CciWalletClaim
  | CciUdClaim
  | CciPqcClaim;

/** A resolved cross-context identity record for a subject. */
export interface CciRecord {
  /** The subject's primary claim — the Demos ed25519 public-key hex / DID root. */
  primaryClaim: string;
  /** Linked Web2 handles (includes DNS `domain` identities). */
  web2: CciWeb2Claim[];
  /** Linked cross-chain wallets. */
  wallets: CciWalletClaim[];
  /** Linked Unstoppable Domains. */
  ud: CciUdClaim[];
  /** Linked post-quantum public keys. */
  pqc: CciPqcClaim[];
  /** All linked claims (web2 ++ wallets ++ ud ++ pqc), for convenience. */
  claims: CciClaim[];
  /** The raw substrate payload, for anything not yet modelled. */
  raw: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The GCR identity graph can arrive wrapped in RPC envelopes (`{ result, response:
 * {...} }`, `{ response: { response: {...} } }`, `{ data: {...} }`, …). Walk a few
 * known wrappers to find the object that actually carries the identity fields.
 * The deployed testnet graph is keyed `xm` / `web2` / `ud` / `pqc`; the older
 * `linkedSocials` / `linkedWallets` shape is also recognised.
 */
function unwrapIdentityPayload(raw: unknown): Record<string, unknown> {
  let cur: unknown = raw;
  for (let i = 0; i < 6 && isObj(cur); i++) {
    const o = cur as Record<string, unknown>;
    if (
      "xm" in o ||
      "web2" in o ||
      "ud" in o ||
      "pqc" in o ||
      "linkedWallets" in o ||
      "linkedSocials" in o
    )
      return o;
    if (isObj(o.response)) cur = o.response;
    else if (isObj(o.data)) cur = o.data;
    else break;
  }
  return isObj(cur) ? cur : {};
}

function dedupeByRef<T extends { ref: string }>(claims: T[]): T[] {
  const seen = new Set<string>();
  return claims.filter((c) => (seen.has(c.ref) ? false : (seen.add(c.ref), true)));
}

/** Pull a web2 handle out of an entry, which may be a bare string or an object. */
function web2Handle(entry: unknown): string {
  if (typeof entry === "string") return entry.trim();
  if (isObj(entry)) {
    const v = entry["username"] ?? entry["handle"] ?? entry["userId"];
    if (typeof v === "string") return v.trim();
  }
  return "";
}

/** The proof URL / hash / signature the node attested, if the entry carries one. */
function claimProof(entry: unknown): string | undefined {
  if (!isObj(entry)) return undefined;
  const p =
    entry["proof"] ??
    entry["proofUrl"] ??
    entry["proofHash"] ??
    entry["signature"];
  return typeof p === "string" && p.trim() !== "" ? p.trim() : undefined;
}

/**
 * Validate a DNS hostname AND canonicalise it for the DACS `domain:` claim ref.
 * Returns `""` for anything that is not a bare public hostname — both call sites
 * treat `""` as "skip": the emit path drops the entry, the alias fold returns
 * the original ref unchanged (fail-closed, operator-approved).
 *
 * Validation runs on the RAW input, BEFORE domainToASCII, because domainToASCII
 * is a URL host PARSER, not a validator: it silently STRIPS a path / query /
 * fragment / userinfo and rewrites IP forms, so once it returns you can no
 * longer tell what it discarded (e.g. `alice.example/path` → `alice.example`,
 * `0xc0.0x00.0x02.0x01` → `192.0.2.1`) — distinct inputs would collapse to the
 * same ref and false-match. So we reject the raw input if it carries any URL
 * structure (`/ \ ? # @ :`), a `%` (a host never legally contains one, and
 * `%2e`/`%61` decode to `.`/`a` — a live bypass of this very check), whitespace,
 * or an ASCII control char, or is empty. Then we IDNA-encode (domainToASCII
 * lower-cases + punycodes) and reject the RESULT if it is empty, an IP literal —
 * an output-side `isIP` test catches every alternate IPv4 spelling with one
 * check, since domainToASCII normalises them all to a dotted quad (IPv6 forms
 * never reach here: they carry `:` and are rejected raw) — or ends in a trailing
 * dot (checked output-side so a terminal ideographic/fullwidth dot that maps to
 * "." is caught too). Trailing dots complete DACS-Standard #275's enumerated
 * reject-list: ports, paths, credentials, queries, fragments, IP literals,
 * trailing dots. Single-label hosts, empty labels (`a..b`), and leading/trailing
 * hyphens remain accepted-as-distinct: domainToASCII preserves each, so they
 * never collapse into a false-match — whether to normalise them is a
 * Standard-side question, not a security one.
 */
function canonicalDomainHost(handle: string): string {
  // Raw-input reject: URL structure, `%` (percent-encoding), whitespace,
  // C0 controls / DEL, or empty.
  if (handle === "" || /[/\\?#@:%\s\u0000-\u001f\u007f]/.test(handle)) return "";
  const host = domainToASCII(handle).trim();
  if (!host) return "";
  if (isIP(host) !== 0) return ""; // IPv4 (any spelling) — IPv6 already rejected raw
  if (host.endsWith(".")) return ""; // trailing dot (incl. mapped ideographic/fullwidth) — #275
  return host;
}

function parseWeb2(payload: Record<string, unknown>): CciWeb2Claim[] {
  const out: CciWeb2Claim[] = [];
  // Primary: the live GCR shape — `web2.<platform>[]` of proof objects.
  const web2 = payload["web2"];
  if (isObj(web2)) {
    for (const [platform, entries] of Object.entries(web2)) {
      const list = Array.isArray(entries) ? entries : [entries];
      for (const entry of list) {
        const handle = web2Handle(entry);
        if (!handle) continue;
        const proof = claimProof(entry);
        // A DNS `domain` identity emits the canonical DACS `domain:<host>` ref
        // (IDNA/lower-cased host); every other platform keeps the historical
        // `web2:<platform>:<handle>` form. This mirrors the UD precedent below
        // (`cci-ud:${domain.toLowerCase()}`, see CF-2): only `ref` is
        // canonicalised — the `handle` field keeps its original casing.
        let ref: string;
        // The GCR platform-key casing is not under our control ("Domain"/"DOMAIN"
        // occur), so canonical emission must not depend on it — match case-insensitively.
        if (platform.toLowerCase() === "domain") {
          const host = canonicalDomainHost(handle);
          if (!host) continue; // "" ⇒ not a resolvable hostname → skip (fail-closed)
          ref = `domain:${host}`;
        } else {
          ref = `web2:${platform}:${handle}`;
        }
        out.push({
          kind: "web2",
          platform,
          handle,
          ref,
          ...(proof ? { proof } : {}),
        });
      }
    }
  }
  // Fallback: the older flat `linkedSocials: { platform: "handle" }` shape.
  const socials = payload["linkedSocials"];
  if (isObj(socials)) {
    for (const [platform, value] of Object.entries(socials)) {
      const handle = typeof value === "string" ? value.trim() : "";
      if (!handle) continue;
      // Same domain-canonicalisation as the primary GCR shape above (case-insensitive key).
      let ref: string;
      if (platform.toLowerCase() === "domain") {
        const host = canonicalDomainHost(handle);
        if (!host) continue; // "" ⇒ not a resolvable hostname → skip (fail-closed)
        ref = `domain:${host}`;
      } else {
        ref = `web2:${platform}:${handle}`;
      }
      out.push({ kind: "web2", platform, handle, ref });
    }
  }
  return dedupeByRef(out);
}

/** Extract an address from an xm identity link (object with `.address`, or a bare string). */
function xmAddress(link: unknown): string {
  if (typeof link === "string") return link;
  if (isObj(link) && typeof link["address"] === "string") return link["address"];
  return "";
}

function parseWallets(payload: Record<string, unknown>): CciWalletClaim[] {
  const out: CciWalletClaim[] = [];
  // Primary: the live GCR shape — `xm.<chainType>.<network>[].address`.
  const xm = payload["xm"];
  if (isObj(xm)) {
    for (const [chainType, networks] of Object.entries(xm)) {
      if (!isObj(networks)) continue;
      for (const links of Object.values(networks)) {
        const list = Array.isArray(links) ? links : [links];
        for (const link of list) {
          const address = xmAddress(link);
          if (!address) continue;
          out.push({
            kind: "wallet",
            chainType,
            address,
            ref: `xm:${chainType}:${address}`,
          });
        }
      }
    }
  }
  // Fallback: the older `linkedWallets: "<chainType>:<address>"[]` shape.
  const linked = payload["linkedWallets"];
  if (Array.isArray(linked)) {
    for (const entry of linked) {
      if (typeof entry !== "string") continue;
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
  }
  return dedupeByRef(out);
}

/** Flatten a GCR family field that may be an array or an object-of-lists. */
function familyEntries(field: unknown): unknown[] {
  if (Array.isArray(field)) return field;
  if (isObj(field)) return Object.values(field).flatMap((v) => (Array.isArray(v) ? v : [v]));
  return [];
}

function parseUd(payload: Record<string, unknown>): CciUdClaim[] {
  const out: CciUdClaim[] = [];
  for (const entry of familyEntries(payload["ud"])) {
    if (!isObj(entry)) continue;
    const domain = typeof entry["domain"] === "string" ? entry["domain"].trim() : "";
    if (!domain) continue;
    const network = typeof entry["network"] === "string" ? entry["network"] : undefined;
    const proof = claimProof(entry);
    out.push({
      kind: "ud",
      domain,
      ...(network ? { network } : {}),
      // CF-2: UD domains are case-insensitive, so the canonical ref lower-cases
      // the domain (the display `domain` field keeps the original casing).
      ref: `cci-ud:${domain.toLowerCase()}`,
      ...(proof ? { proof } : {}),
    });
  }
  return dedupeByRef(out);
}

function parsePqc(payload: Record<string, unknown>): CciPqcClaim[] {
  const out: CciPqcClaim[] = [];
  for (const entry of familyEntries(payload["pqc"])) {
    if (!isObj(entry)) continue;
    const algorithm = typeof entry["algorithm"] === "string" ? entry["algorithm"].trim() : "";
    const address = typeof entry["address"] === "string" ? entry["address"].trim() : "";
    if (!algorithm || !address) continue;
    out.push({
      kind: "pqc",
      algorithm,
      address,
      // CF-2: the algorithm is a lower-case enum; the public key is
      // case-significant, so it is NOT normalised (an exact-match identifier).
      ref: `cci-pqc:${algorithm.toLowerCase()}:${address}`,
    });
  }
  return dedupeByRef(out);
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
  const ud = parseUd(payload);
  const pqc = parsePqc(payload);
  return {
    primaryClaim,
    web2,
    wallets,
    ud,
    pqc,
    claims: [...web2, ...wallets, ...ud, ...pqc],
    raw,
  };
}

/** A claim ref decomposed into its addressable parts (for reverse lookup). */
export type ParsedClaimRef =
  | { kind: "web2"; platform: string; handle: string }
  | { kind: "wallet"; chainType: string; address: string };

/**
 * Parse a canonical claim ref back into its parts, or null if it isn't a
 * reverse-resolvable linked-claim ref. Inverse of the `ref` fields produced by
 * {@link parseCciRecord}:
 *   `domain:<host>`            → web2 claim (platform "domain")
 *   `web2:<platform>:<handle>` → web2 claim
 *   `xm:<chainType>:<address>` → wallet claim
 * `web2:domain:<host>` remains accepted as a permanent historical alias for
 * `domain:<host>` (the same web2/"domain" claim).
 * (The primary claim / DID isn't a linked-claim ref and returns null.)
 */
export function parseClaimRef(ref: string): ParsedClaimRef | null {
  const web2 = /^web2:([^:]+):(.+)$/.exec(ref);
  if (web2) return { kind: "web2", platform: web2[1]!, handle: web2[2]! };
  // Canonical DACS domain ref → the same web2/"domain" shape. `web2:domain:<h>`
  // above stays a permanent historical alias for the identical claim. Ordered
  // after the `web2:` arm so no ref can match both. Scheme matched
  // case-insensitively to agree with canonicalizeDomainAlias (read path).
  const domain = /^domain:(.+)$/i.exec(ref);
  if (domain) return { kind: "web2", platform: "domain", handle: domain[1]! };
  const xm = /^xm:([^:]+):(.+)$/.exec(ref);
  if (xm) return { kind: "wallet", chainType: xm[1]!, address: xm[2]! };
  return null;
}

/** Every claim ref for a record, primary first. */
export function cciClaimRefs(record: CciRecord): string[] {
  return [record.primaryClaim, ...record.claims.map((c) => c.ref)];
}

/**
 * Normalise a claim ref for MATCHING ONLY: fold BOTH the legacy
 * `web2:domain:<host>` alias AND the canonical `domain:<host>` form to
 * `domain:<idna-host>`, IDNA-normalising the host via {@link canonicalDomainHost}
 * so the match path canonicalises to the SAME depth as the write path (which
 * also IDNA-encodes) — otherwise a stored `domain:xn--bcher-kva.example` would
 * never match a signed `web2:domain:Bücher.example` or a unicode
 * `domain:Bücher.example` requirement. ASCII hosts are unaffected. The prefix is
 * matched case-insensitively; every other ref (xm: / cci-ud: / cci-pqc: / DIDs /
 * unknown) is returned unchanged. If the host cannot be IDNA-resolved
 * (canonicalDomainHost returns ""), return the ORIGINAL ref UNCHANGED — never a
 * bare `domain:`, so two distinct unresolvable refs can't collapse and
 * false-match. WHY: the historical signed artifact is not the CCI record
 * (re-derived from the raw GCR on every call) but the requirement string — a
 * steward-signed recipe's params.requiredClaim (see vetCore.ts cci-claim) or a
 * presented IdentityBundle's claims[].ref. Those may carry the legacy alias and
 * MUST keep resolving. We normalise at compare time only; we never rewrite or
 * re-hash a stored or signed value.
 */
function canonicalizeDomainAlias(ref: string): string {
  const m = /^(?:web2:domain|domain):(.+)$/i.exec(ref);
  if (!m) return ref;
  // Trim to match web2Handle (emit path), so both paths canonicalise identically.
  const host = canonicalDomainHost(m[1]!.trim());
  return host ? `domain:${host}` : ref;
}

/**
 * Does the record assert `ref`? Matches the primary claim or any linked claim.
 * Web2 and UD refs match case-insensitively (handles/domains aren't
 * case-sensitive); wallet / pqc / primary refs match exactly.
 */
export function cciHasClaim(record: CciRecord, ref: string): boolean {
  if (ref === record.primaryClaim) return true;
  // Fold the legacy web2:domain: alias into canonical domain: on BOTH the query
  // and the stored ref, web2/ud branch only (compare-time only, see
  // canonicalizeDomainAlias). wallet / pqc keep matching exactly.
  const lower = canonicalizeDomainAlias(ref).toLowerCase();
  return record.claims.some((c) =>
    c.kind === "web2" || c.kind === "ud"
      ? canonicalizeDomainAlias(c.ref).toLowerCase() === lower
      : c.ref === ref,
  );
}

/**
 * The attested proof carried by the claim `ref`, or undefined if the record
 * holds no such claim or the claim carries no proof. Only proof-bearing
 * families (web2 / ud) can return a value; the primary claim is self-evident
 * (undefined). A stricter vet can require this to be present — a claim with a
 * proof was attested by the node, not merely asserted.
 */
export function cciClaimProof(record: CciRecord, ref: string): string | undefined {
  // Same compare-time alias normalisation as cciHasClaim (web2/ud branch only).
  const lower = canonicalizeDomainAlias(ref).toLowerCase();
  for (const c of record.claims) {
    if (
      (c.kind === "web2" || c.kind === "ud") &&
      canonicalizeDomainAlias(c.ref).toLowerCase() === lower
    ) {
      return c.proof;
    }
  }
  return undefined;
}

/** Does the record assert `ref` AND carry an attested proof for it? */
export function cciClaimHasProof(record: CciRecord, ref: string): boolean {
  return cciClaimProof(record, ref) !== undefined;
}
