/**
 * CCI (Cross-Context Identity) — the DACS-1 Identify layer.
 *
 * Demos stores eight production identity contexts in GCRMain.identities. This
 * module owns a stable JSON snapshot of a `getIdentities` response and projects
 * every context into canonical DACS-1 ClaimReferences. Entries that cannot be
 * represented without inventing an identifier are retained only in `raw`.
 */

import { snapshotWireJsonRead } from "../canonical/snapshot.js";
import { isCanonicalClaimReference } from "./claimReference.js";
import {
  canonicalizeNativeDomainHostname,
  isCanonicalDomainHostname,
} from "./domainHost.js";

/** Claim families beyond the primary key. */
export type CciClaimKind =
  | "web2"
  | "wallet"
  | "ud"
  | "pqc"
  | "nomis"
  | "humanpassport"
  | "ethos"
  | "tlsn";

/** A linked Web2 handle (X / GitHub / Discord / Telegram / a DNS domain). */
export interface CciWeb2Claim {
  kind: "web2";
  platform: "twitter" | "github" | "discord" | "telegram" | "domain";
  handle: string;
  /** `cci-web2:<platform>:<handle>`, or `domain:<hostname>` for DNS identities. */
  ref: string;
  /** Proof commitment carried by GCR, when present. */
  proof?: string;
}

/** A linked cross-chain wallet (the Demos `xm` context). */
export interface CciWalletClaim {
  kind: "wallet";
  chainType: string;
  subchain: string;
  address: string;
  /** Canonical `cci-xm:<chain>:<subchain>:<address>` reference. */
  ref: string;
}

/** A linked Unstoppable Domain. */
export interface CciUdClaim {
  kind: "ud";
  domain: string;
  network?: string;
  ref: string;
  proof?: string;
}

/** A linked post-quantum public key. */
export interface CciPqcClaim {
  kind: "pqc";
  algorithm: "falcon" | "ml-dsa";
  address: string;
  ref: string;
}

/** A Nomis wallet-score subject validated by the native GCR routine. */
export interface CciNomisClaim {
  kind: "nomis";
  chain: string;
  subchain: string;
  address: string;
  score: number;
  scoreType: number;
  mintedScore?: number | null;
  /** Milliseconds since Unix epoch derived from `lastSyncedAt`. */
  observedAt: number;
  ref: string;
}

/** A Human Passport proof-of-personhood identity validated by GCR. */
export interface CciHumanPassportClaim {
  kind: "humanpassport";
  /** Demos persists the verified EVM address as this context's unique id. */
  id: string;
  address: string;
  score: number;
  passingScore: boolean;
  threshold?: number;
  stamps: string[];
  verificationMethod: "api" | "onchain";
  chainId?: number;
  observedAt: number;
  expiresAt: number | null;
  ref: string;
}

/** An Ethos profile and score validated by the native GCR routine. */
export interface CciEthosClaim {
  kind: "ethos";
  id: string;
  profileId: number;
  chain: string;
  subchain: string;
  address: string;
  score: number;
  observedAt: number;
  ref: string;
}

/** A TLSNotary proof commitment already verified by the Demos GCR routine. */
export interface CciTlsnClaim {
  kind: "tlsn";
  context: "github" | "discord" | "telegram";
  username: string;
  userId: string;
  proofHash: string;
  observedAt?: number;
  ref: string;
}

export type CciClaim =
  | CciWeb2Claim
  | CciWalletClaim
  | CciUdClaim
  | CciPqcClaim
  | CciNomisClaim
  | CciHumanPassportClaim
  | CciEthosClaim
  | CciTlsnClaim;

/** A resolved cross-context identity record for a subject. */
export interface CciRecord {
  primaryClaim: string;
  web2: CciWeb2Claim[];
  wallets: CciWalletClaim[];
  ud: CciUdClaim[];
  pqc: CciPqcClaim[];
  nomis: CciNomisClaim[];
  humanPassport: CciHumanPassportClaim[];
  ethos: CciEthosClaim[];
  tlsn: CciTlsnClaim[];
  claims: CciClaim[];
  /** Owned, stable JSON snapshot of the substrate response. */
  raw: unknown;
}

const WEB2_PLATFORMS = new Set([
  "twitter",
  "github",
  "discord",
  "telegram",
  "domain",
]);
const TLSN_CONTEXTS = new Set(["github", "discord", "telegram"]);
const HEX_32 = /^[0-9a-f]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const isObj = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonBlank = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
const safeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) &&
  Math.abs(value) <= Number.MAX_SAFE_INTEGER
    ? value
    : undefined;
const nonNegativeSafeNumber = (value: unknown): number | undefined => {
  const number = safeNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
};
const nonNegativeSafeInteger = (value: unknown): number | undefined => {
  const number = nonNegativeSafeNumber(value);
  return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
};
const epochMilliseconds = (value: unknown): number | undefined => {
  if (typeof value === "number") return nonNegativeSafeInteger(value);
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

function canonicalRef(value: string): string | undefined {
  return isCanonicalClaimReference(value) ? value : undefined;
}

/** Locate the GCR identities object inside the supported RPC envelopes. */
function unwrapIdentityPayload(raw: unknown): Record<string, unknown> {
  let current: unknown = raw;
  for (let depth = 0; depth < 6 && isObj(current); depth += 1) {
    const object = current;
    if (
      Object.prototype.hasOwnProperty.call(object, "result") &&
      object.result !== 200
    ) {
      return {};
    }
    if (
      "xm" in object ||
      "web2" in object ||
      "ud" in object ||
      "pqc" in object ||
      "nomis" in object ||
      "humanpassport" in object ||
      "ethos" in object ||
      "tlsn" in object ||
      "linkedWallets" in object ||
      "linkedSocials" in object
    ) {
      return object;
    }
    if (isObj(object.response)) current = object.response;
    else if (isObj(object.data)) current = object.data;
    else break;
  }
  return isObj(current) ? current : {};
}

function dedupeByRef<T extends { ref: string }>(claims: T[]): T[] {
  const seen = new Set<string>();
  return claims.filter((claim) => {
    if (seen.has(claim.ref)) return false;
    seen.add(claim.ref);
    return true;
  });
}

function web2Handle(entry: unknown, trim = true): string {
  if (typeof entry === "string") return trim ? entry.trim() : entry;
  if (!isObj(entry)) return "";
  const value = entry.username ?? entry.handle ?? entry.userId;
  return typeof value === "string" ? (trim ? value.trim() : value) : "";
}

function claimProof(entry: unknown): string | undefined {
  if (!isObj(entry)) return undefined;
  const proof = entry.proofUrl ?? entry.proofHash ?? entry.signature ?? entry.proof;
  return typeof proof === "string" && proof.trim() !== "" ? proof.trim() : undefined;
}

function parseWeb2(payload: Record<string, unknown>): CciWeb2Claim[] {
  const claims: CciWeb2Claim[] = [];
  const web2 = payload.web2;
  if (isObj(web2)) {
    for (const [sourcePlatform, entries] of Object.entries(web2)) {
      const platform = sourcePlatform.toLowerCase();
      if (!WEB2_PLATFORMS.has(platform)) continue;
      for (const entry of Array.isArray(entries) ? entries : [entries]) {
        const handle = web2Handle(entry, platform !== "domain");
        if (!handle) continue;
        const ref = platform === "domain"
          ? (() => {
              const host = canonicalizeNativeDomainHostname(handle);
              return host ? `domain:${host}` : undefined;
            })()
          : canonicalRef(`cci-web2:${platform}:${handle}`);
        if (!ref) continue;
        const proof = claimProof(entry);
        claims.push({
          kind: "web2",
          platform: platform as CciWeb2Claim["platform"],
          handle,
          ref,
          ...(proof ? { proof } : {}),
        });
      }
    }
  }

  const linkedSocials = payload.linkedSocials;
  if (isObj(linkedSocials)) {
    for (const [sourcePlatform, value] of Object.entries(linkedSocials)) {
      const platform = sourcePlatform.toLowerCase();
      if (!WEB2_PLATFORMS.has(platform) || typeof value !== "string") continue;
      const handle = platform === "domain" ? value : value.trim();
      if (!handle) continue;
      const ref = platform === "domain"
        ? (() => {
            const host = canonicalizeNativeDomainHostname(handle);
            return host ? `domain:${host}` : undefined;
          })()
        : canonicalRef(`cci-web2:${platform}:${handle}`);
      if (!ref) continue;
      claims.push({
        kind: "web2",
        platform: platform as CciWeb2Claim["platform"],
        handle,
        ref,
      });
    }
  }
  return dedupeByRef(claims);
}

function addressFrom(entry: unknown): string | undefined {
  if (typeof entry === "string") return nonBlank(entry);
  return isObj(entry) ? nonBlank(entry.address) : undefined;
}

function parseWallets(payload: Record<string, unknown>): CciWalletClaim[] {
  const claims: CciWalletClaim[] = [];
  if (isObj(payload.xm)) {
    for (const [chainType, subchains] of Object.entries(payload.xm)) {
      if (!isObj(subchains) || !nonBlank(chainType)) continue;
      for (const [subchain, entries] of Object.entries(subchains)) {
        if (!nonBlank(subchain)) continue;
        for (const entry of Array.isArray(entries) ? entries : [entries]) {
          const address = addressFrom(entry);
          if (!address) continue;
          const ref = canonicalRef(`cci-xm:${chainType}:${subchain}:${address}`);
          if (!ref) continue;
          claims.push({ kind: "wallet", chainType, subchain, address, ref });
        }
      }
    }
  }

  // The historical flattened shape is usable only when it carries all three
  // DACS coordinates. A two-component `chain:address` value has no canonical
  // subchain and is deliberately retained only in `raw`.
  if (Array.isArray(payload.linkedWallets)) {
    for (const entry of payload.linkedWallets) {
      if (typeof entry !== "string") continue;
      const first = entry.indexOf(":");
      const second = entry.indexOf(":", first + 1);
      if (first <= 0 || second <= first + 1 || second === entry.length - 1) continue;
      const chainType = entry.slice(0, first);
      const subchain = entry.slice(first + 1, second);
      const address = entry.slice(second + 1);
      const ref = canonicalRef(`cci-xm:${chainType}:${subchain}:${address}`);
      if (ref) claims.push({ kind: "wallet", chainType, subchain, address, ref });
    }
  }
  return dedupeByRef(claims);
}

function flatEntries(field: unknown): unknown[] {
  if (Array.isArray(field)) return field;
  if (!isObj(field)) return [];
  return Object.values(field).flatMap((value) =>
    Array.isArray(value) ? value : [value],
  );
}

function parseUd(payload: Record<string, unknown>): CciUdClaim[] {
  const claims: CciUdClaim[] = [];
  for (const entry of flatEntries(payload.ud)) {
    if (!isObj(entry)) continue;
    const domain = nonBlank(entry.domain);
    if (!domain) continue;
    const ref = canonicalRef(`cci-ud:${domain.toLowerCase()}`);
    if (!ref) continue;
    const network = nonBlank(entry.network);
    const proof = claimProof(entry);
    claims.push({
      kind: "ud",
      domain,
      ...(network ? { network } : {}),
      ref,
      ...(proof ? { proof } : {}),
    });
  }
  return dedupeByRef(claims);
}

function parsePqc(payload: Record<string, unknown>): CciPqcClaim[] {
  const claims: CciPqcClaim[] = [];
  const add = (algorithmValue: unknown, entry: unknown): void => {
    const algorithm = nonBlank(algorithmValue)?.toLowerCase();
    const address = addressFrom(entry);
    if ((algorithm !== "falcon" && algorithm !== "ml-dsa") || !address) return;
    const ref = canonicalRef(`cci-pqc:${algorithm}:${address}`);
    if (!ref) return;
    claims.push({ kind: "pqc", algorithm, address, ref });
  };

  if (Array.isArray(payload.pqc)) {
    for (const entry of payload.pqc) {
      add(isObj(entry) ? entry.algorithm : undefined, entry);
    }
  } else if (isObj(payload.pqc)) {
    for (const [algorithm, entries] of Object.entries(payload.pqc)) {
      for (const entry of Array.isArray(entries) ? entries : [entries]) {
        add(algorithm, entry);
      }
    }
  }
  return dedupeByRef(claims);
}

function forEachNestedIdentity(
  field: unknown,
  visit: (chain: string, subchain: string, entry: unknown) => void,
): void {
  if (!isObj(field)) return;
  for (const [chain, subchains] of Object.entries(field)) {
    if (!isObj(subchains) || !nonBlank(chain)) continue;
    for (const [subchain, entries] of Object.entries(subchains)) {
      if (!nonBlank(subchain)) continue;
      for (const entry of Array.isArray(entries) ? entries : [entries]) {
        visit(chain, subchain, entry);
      }
    }
  }
}

function parseNomis(payload: Record<string, unknown>): CciNomisClaim[] {
  const claims: CciNomisClaim[] = [];
  forEachNestedIdentity(payload.nomis, (chain, subchain, entry) => {
    if (!isObj(entry)) return;
    const address = nonBlank(entry.address);
    const score = nonNegativeSafeNumber(entry.score);
    const scoreType = nonNegativeSafeInteger(entry.scoreType);
    const observedAt = epochMilliseconds(entry.lastSyncedAt);
    if (!address || score === undefined || scoreType === undefined || observedAt === undefined) {
      return;
    }
    const minted = entry.mintedScore;
    const mintedScore = minted === null ? null : nonNegativeSafeNumber(minted);
    if (minted !== undefined && mintedScore === undefined) return;
    const ref = canonicalRef(`cci-nomis:${address}`);
    if (!ref) return;
    claims.push({
      kind: "nomis",
      chain,
      subchain,
      address,
      score,
      scoreType,
      ...(minted !== undefined ? { mintedScore } : {}),
      observedAt,
      ref,
    });
  });
  return dedupeByRef(claims);
}

function parseHumanPassport(
  payload: Record<string, unknown>,
): CciHumanPassportClaim[] {
  const claims: CciHumanPassportClaim[] = [];
  for (const entry of flatEntries(payload.humanpassport)) {
    if (!isObj(entry)) continue;
    const addressValue = nonBlank(entry.address);
    const address = addressValue && EVM_ADDRESS.test(addressValue)
      ? addressValue.toLowerCase()
      : undefined;
    const score = nonNegativeSafeNumber(entry.score);
    const observedAt = epochMilliseconds(entry.verifiedAt);
    const method = entry.verificationMethod;
    const stamps = entry.stamps;
    const expiresAt = entry.expiresAt === null
      ? null
      : epochMilliseconds(entry.expiresAt);
    if (
      !address ||
      score === undefined ||
      typeof entry.passingScore !== "boolean" ||
      observedAt === undefined ||
      (method !== "api" && method !== "onchain") ||
      !Array.isArray(stamps) ||
      !stamps.every((stamp) => typeof stamp === "string" && stamp.trim() !== "") ||
      expiresAt === undefined
    ) {
      continue;
    }
    const threshold = nonNegativeSafeNumber(entry.threshold);
    if (entry.threshold !== undefined && threshold === undefined) continue;
    const chainId = nonNegativeSafeInteger(entry.chainId);
    if (entry.chainId !== undefined && chainId === undefined) continue;
    const ref = canonicalRef(`cci-humanpassport:${address}`);
    if (!ref) continue;
    claims.push({
      kind: "humanpassport",
      id: address,
      address,
      score,
      passingScore: entry.passingScore,
      ...(threshold !== undefined ? { threshold } : {}),
      stamps: [...stamps],
      verificationMethod: method,
      ...(chainId !== undefined ? { chainId } : {}),
      observedAt,
      expiresAt,
      ref,
    });
  }
  return dedupeByRef(claims);
}

function parseEthos(payload: Record<string, unknown>): CciEthosClaim[] {
  const claims: CciEthosClaim[] = [];
  forEachNestedIdentity(payload.ethos, (chain, subchain, entry) => {
    if (!isObj(entry)) return;
    const address = nonBlank(entry.address);
    const score = nonNegativeSafeNumber(entry.score);
    const profileId = nonNegativeSafeInteger(entry.profileId);
    const observedAt = epochMilliseconds(entry.lastSyncedAt);
    // DACS-1 identifies this scheme by Ethos profile id. Older GCR records
    // without one cannot be made canonical by substituting a wallet address.
    if (!address || score === undefined || profileId === undefined || observedAt === undefined) {
      return;
    }
    const id = String(profileId);
    const ref = canonicalRef(`cci-ethos:${id}`);
    if (!ref) return;
    claims.push({
      kind: "ethos",
      id,
      profileId,
      chain,
      subchain,
      address,
      score,
      observedAt,
      ref,
    });
  });
  return dedupeByRef(claims);
}

function parseTlsn(payload: Record<string, unknown>): CciTlsnClaim[] {
  const claims: CciTlsnClaim[] = [];
  const add = (
    contextValue: unknown,
    entry: unknown,
    dedicatedContext = false,
  ): void => {
    const context = nonBlank(contextValue)?.toLowerCase();
    if (!context || !TLSN_CONTEXTS.has(context) || !isObj(entry)) return;
    if (!dedicatedContext && entry.proofType !== "tlsn") return;
    const username = nonBlank(entry.username);
    const userIdValue = entry.userId;
    const userId = typeof userIdValue === "string"
      ? nonBlank(userIdValue)
      : typeof userIdValue === "number" && Number.isSafeInteger(userIdValue)
        ? String(userIdValue)
        : undefined;
    const proofHash = nonBlank(entry.proofHash)?.toLowerCase();
    if (!username || !userId || !proofHash || !HEX_32.test(proofHash)) return;
    const observedAt = epochMilliseconds(entry.timestamp);
    const ref = canonicalRef(`cci-tlsn:${proofHash}`);
    if (!ref) return;
    claims.push({
      kind: "tlsn",
      context: context as CciTlsnClaim["context"],
      username,
      userId,
      proofHash,
      ...(observedAt !== undefined ? { observedAt } : {}),
      ref,
    });
  };

  // Current Demos nodes persist TLSN-verified identities inside web2 buckets.
  if (isObj(payload.web2)) {
    for (const [context, entries] of Object.entries(payload.web2)) {
      for (const entry of Array.isArray(entries) ? entries : [entries]) {
        add(context, entry);
      }
    }
  }
  // Also accept the dedicated context shape if a later node exposes it.
  if (isObj(payload.tlsn)) {
    for (const [context, entries] of Object.entries(payload.tlsn)) {
      for (const entry of Array.isArray(entries) ? entries : [entries]) {
        add(context, entry, true);
      }
    }
  } else if (Array.isArray(payload.tlsn)) {
    for (const entry of payload.tlsn) {
      add(isObj(entry) ? entry.context : undefined, entry, true);
    }
  }
  return dedupeByRef(claims);
}

/** Parse and own a raw Demos GCR identity response. */
export function parseCciRecord(primaryClaim: string, raw: unknown): CciRecord {
  const ownedRaw = snapshotWireJsonRead(raw, "Demos GCR identity response");
  const payload = unwrapIdentityPayload(ownedRaw);
  const web2 = parseWeb2(payload);
  const wallets = parseWallets(payload);
  const ud = parseUd(payload);
  const pqc = parsePqc(payload);
  const nomis = parseNomis(payload);
  const humanPassport = parseHumanPassport(payload);
  const ethos = parseEthos(payload);
  const tlsn = parseTlsn(payload);
  return {
    primaryClaim,
    web2,
    wallets,
    ud,
    pqc,
    nomis,
    humanPassport,
    ethos,
    tlsn,
    claims: [
      ...web2,
      ...wallets,
      ...ud,
      ...pqc,
      ...nomis,
      ...humanPassport,
      ...ethos,
      ...tlsn,
    ],
    raw: ownedRaw,
  };
}

/** A claim ref decomposed into the coordinates supported by Demos reverse lookup. */
export type ParsedClaimRef =
  | { kind: "web2"; platform: CciWeb2Claim["platform"]; handle: string }
  | {
      kind: "wallet";
      chainType: string;
      subchain: string;
      address: string;
    };

/** Parse only canonical linked refs that the current Demos SDK can reverse-resolve. */
export function parseClaimRef(ref: string): ParsedClaimRef | null {
  const web2 = /^cci-web2:(twitter|github|discord|telegram):(.+)$/.exec(ref);
  if (web2 && isCanonicalClaimReference(ref)) {
    return {
      kind: "web2",
      platform: web2[1] as Exclude<CciWeb2Claim["platform"], "domain">,
      handle: web2[2]!,
    };
  }
  const domain = /^domain:(.+)$/.exec(ref);
  if (domain && isCanonicalDomainHostname(domain[1]!)) {
    return { kind: "web2", platform: "domain", handle: domain[1]! };
  }
  const wallet = /^cci-xm:([^:]+):([^:]+):(.+)$/.exec(ref);
  if (wallet && isCanonicalClaimReference(ref)) {
    return {
      kind: "wallet",
      chainType: wallet[1]!,
      subchain: wallet[2]!,
      address: wallet[3]!,
    };
  }
  return null;
}

/** Every claim ref for a record, primary first. */
export function cciClaimRefs(record: CciRecord): string[] {
  return [record.primaryClaim, ...record.claims.map((claim) => claim.ref)];
}

function canonicalDomainRef(ref: string): string | null {
  if (!ref.startsWith("domain:")) return null;
  const hostname = ref.slice("domain:".length);
  return isCanonicalDomainHostname(hostname) ? ref : null;
}

/** Does the record assert the exact canonical ref? */
export function cciHasClaim(record: CciRecord, ref: string): boolean {
  if (ref === record.primaryClaim) return true;
  const requestedDomain = canonicalDomainRef(ref);
  if (/^(?:domain|(?:cci-)?web2:domain):/i.test(ref)) {
    return requestedDomain !== null && record.claims.some(
      (claim) => canonicalDomainRef(claim.ref) === requestedDomain,
    );
  }
  const lower = ref.toLowerCase();
  return record.claims.some((claim) =>
    claim.kind === "web2" || claim.kind === "ud"
      ? claim.ref.toLowerCase() === lower
      : claim.ref === ref,
  );
}

/** Return a stored proof commitment for proof-bearing CCI families. */
export function cciClaimProof(record: CciRecord, ref: string): string | undefined {
  const requestedDomain = canonicalDomainRef(ref);
  if (/^(?:domain|(?:cci-)?web2:domain):/i.test(ref)) {
    if (requestedDomain === null) return undefined;
    const claim = record.claims.find(
      (candidate) => canonicalDomainRef(candidate.ref) === requestedDomain,
    );
    return claim?.kind === "web2" || claim?.kind === "ud"
      ? claim.proof
      : undefined;
  }
  const lower = ref.toLowerCase();
  for (const claim of record.claims) {
    if (
      (claim.kind === "web2" || claim.kind === "ud") &&
      claim.ref.toLowerCase() === lower
    ) {
      return claim.proof;
    }
    if (claim.kind === "tlsn" && claim.ref === ref) return claim.proofHash;
  }
  return undefined;
}

/** Does the record assert `ref` and carry a native proof commitment for it? */
export function cciClaimHasProof(record: CciRecord, ref: string): boolean {
  return cciClaimProof(record, ref) !== undefined;
}
