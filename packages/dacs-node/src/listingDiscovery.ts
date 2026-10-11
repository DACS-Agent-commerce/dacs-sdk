import {
  constants,
} from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { isListing, type Listing } from "@kynesyslabs/dacs/artifacts";
import {
  canonicalize,
  contentHash,
  listingAddress,
  sha256Hex,
} from "@kynesyslabs/dacs/canonical";
import { sameCanonicalClaimIdentity } from "@kynesyslabs/dacs/identity";

import type {
  DacsListingDiscoveryPublicationInputV1,
  DacsListingDiscoveryPublicationV1,
  DacsListingDiscoveryPublisherV1,
} from "./listingSetup.js";
import { dacsListingOfferGroupV1 } from "./listingOffer.js";

const MAX_INDEX_BYTES = 1_048_576;
const INDEX_FILE = "listings.json";

export interface DacsListingDiscoveryStoreOptionsV1 {
  directory: string;
  sellerAuthority: string;
  sellerPublicEndpoint: string;
  now?(): number;
}

export interface DacsListingIndexEntryV1 {
  listingId: string;
  version: number;
  contentHash: string;
  /** Non-authoritative grouping hint; the selected Listing is still verified. */
  offerGroup?: string;
  anchor: Readonly<{ kind: "storage-program"; locator: string }>;
  summary: Readonly<{
    title: string;
    category: string;
    tags: readonly string[];
    priceHint?: string;
  }>;
  status: "active";
}

export interface DacsListingIndexV1 {
  indexVersion: "1";
  generatedAt: number;
  seller: string;
  listings: readonly Readonly<DacsListingIndexEntryV1>[];
}

export interface DacsAgentCardV1 {
  dacs: Readonly<{
    dacsVersion: "1";
    listings: Readonly<{ indexUrl: string; indexHash: string }>;
  }>;
}

export interface DacsListingDiscoveryStoreV1
  extends DacsListingDiscoveryPublisherV1 {
  readIndex(): Promise<Readonly<DacsListingIndexV1>>;
  readAgentCard(): Promise<Readonly<DacsAgentCardV1>>;
}

export type DacsListingDiscoveryRequestHandlerV1 = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<boolean>;

export class DacsListingDiscoveryStoreError extends Error {
  override readonly name = "DacsListingDiscoveryStoreError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function canonicalCopy<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function exactPublicEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError("seller public endpoint is invalid");
  }
  if (endpoint.protocol !== "https:" || endpoint.username !== "" ||
      endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== "") {
    throw new TypeError("seller public endpoint is invalid");
  }
  return endpoint;
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function indexHash(index: Readonly<DacsListingIndexV1>): string {
  return `sha256-${sha256Hex(canonicalize(index))}`;
}

async function ensureSafeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const observed = await lstat(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!observed.isDirectory() || observed.isSymbolicLink() ||
      (process.platform !== "win32" && (observed.mode & 0o077) !== 0) ||
      (uid !== undefined && observed.uid !== uid)) {
    throw new DacsListingDiscoveryStoreError("listing-discovery-directory-unsafe");
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function safeExistingFile(path: string): Promise<Readonly<{
  size: number;
  dev: number;
  ino: number;
}> | undefined> {
  try {
    const observed = await lstat(path);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!observed.isFile() || observed.isSymbolicLink() || observed.size <= 0 ||
        observed.size > MAX_INDEX_BYTES ||
        (process.platform !== "win32" && (observed.mode & 0o777) !== 0o600) ||
        (uid !== undefined && observed.uid !== uid)) {
      throw new DacsListingDiscoveryStoreError("listing-discovery-index-unsafe");
    }
    return Object.freeze({ size: observed.size, dev: observed.dev, ino: observed.ino });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readSafeFile(path: string): Promise<string | undefined> {
  const initial = await safeExistingFile(path);
  if (initial === undefined) return undefined;
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const admitted = await handle.stat();
    if (!admitted.isFile() || admitted.dev !== initial.dev || admitted.ino !== initial.ino ||
        admitted.size !== initial.size) {
      throw new DacsListingDiscoveryStoreError("listing-discovery-index-raced");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== initial.size || bytes.includes(0)) {
      throw new DacsListingDiscoveryStoreError("listing-discovery-index-unsafe");
    }
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) {
      throw new DacsListingDiscoveryStoreError("listing-discovery-index-unsafe");
    }
    return text;
  } finally {
    await handle?.close();
  }
}

async function atomicWrite(path: string, value: string): Promise<void> {
  if (Buffer.byteLength(value, "utf8") > MAX_INDEX_BYTES) {
    throw new DacsListingDiscoveryStoreError("listing-discovery-index-too-large");
  }
  const directory = dirname(path);
  await ensureSafeDirectory(directory);
  await safeExistingFile(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(value, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await syncDirectory(directory);
    await safeExistingFile(path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function isIndexEntry(value: unknown): value is DacsListingIndexEntryV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const anchor = entry.anchor as Record<string, unknown> | undefined;
  const summary = entry.summary as Record<string, unknown> | undefined;
  return typeof entry.listingId === "string" && entry.listingId.length > 0 &&
    Number.isSafeInteger(entry.version) && (entry.version as number) > 0 &&
    typeof entry.contentHash === "string" && /^[0-9a-f]{64}$/.test(entry.contentHash) &&
    (entry.offerGroup === undefined ||
      typeof entry.offerGroup === "string" && /^[0-9a-f]{64}$/.test(entry.offerGroup)) &&
    anchor !== null && typeof anchor === "object" && !Array.isArray(anchor) &&
    anchor.kind === "storage-program" && typeof anchor.locator === "string" &&
    /^stor-[0-9a-f]{40}$/.test(anchor.locator) &&
    summary !== null && typeof summary === "object" && !Array.isArray(summary) &&
    typeof summary.title === "string" && typeof summary.category === "string" &&
    Array.isArray(summary.tags) && summary.tags.every((tag) => typeof tag === "string") &&
    (summary.priceHint === undefined || typeof summary.priceHint === "string") &&
    entry.status === "active";
}

function parseIndex(text: string, sellerAuthority: string): DacsListingIndexV1 {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new DacsListingDiscoveryStoreError("listing-discovery-index-invalid");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DacsListingDiscoveryStoreError("listing-discovery-index-invalid");
  }
  const index = value as Record<string, unknown>;
  if (index.indexVersion !== "1" ||
      !sameCanonicalClaimIdentity(index.seller, sellerAuthority) ||
      !validTimestamp(index.generatedAt as number) || !Array.isArray(index.listings) ||
      !index.listings.every(isIndexEntry) || canonicalize(value) !== text) {
    throw new DacsListingDiscoveryStoreError("listing-discovery-index-invalid");
  }
  const slots = new Set<string>();
  for (const entry of index.listings) {
    const slot = `${entry.listingId}\0${entry.version}`;
    if (slots.has(slot)) {
      throw new DacsListingDiscoveryStoreError("listing-discovery-index-conflict");
    }
    slots.add(slot);
  }
  return canonicalCopy(value) as DacsListingIndexV1;
}

function entryFor(input: Readonly<DacsListingDiscoveryPublicationInputV1>):
Readonly<DacsListingIndexEntryV1> {
  const listing = canonicalCopy(input.listing) as Listing;
  if (!isListing(listing) || !/^stor-[0-9a-f]{40}$/.test(input.listingRef) ||
      !/^[0-9a-f]{64}$/.test(input.listingContentHash) ||
      contentHash(listing as unknown as Record<string, unknown>) !== input.listingContentHash ||
      listingAddress(listing.seller.identity.presentedBy, listing.listingId,
        listing.listingVersion) !== input.logicalAddress) {
    throw new TypeError("Listing discovery publication input is invalid");
  }
  return Object.freeze({
    listingId: listing.listingId,
    version: listing.listingVersion,
    contentHash: input.listingContentHash,
    offerGroup: dacsListingOfferGroupV1(listing),
    anchor: Object.freeze({ kind: "storage-program" as const, locator: input.listingRef }),
    summary: Object.freeze({
      title: listing.offering.title,
      category: listing.offering.category,
      tags: Object.freeze([...listing.offering.tags]),
      ...(listing.pricing.kind === "fixed"
        ? { priceHint: listing.pricing.price.amount } : {}),
    }),
    status: "active" as const,
  });
}

/**
 * Open the seller-owned, crash-safe well-known Listing index. Only this one
 * canonical file is durable; the agent card is derived from its exact bytes so
 * a crash can never publish a card hash for a different index generation.
 */
export async function openDacsListingDiscoveryStoreV1(
  options: Readonly<DacsListingDiscoveryStoreOptionsV1>,
): Promise<DacsListingDiscoveryStoreV1> {
  if (options === null || typeof options !== "object" ||
      typeof options.directory !== "string" || options.directory.length === 0 ||
      typeof options.sellerAuthority !== "string" || options.sellerAuthority.length === 0 ||
      (options.now !== undefined && typeof options.now !== "function")) {
    throw new TypeError("Listing discovery store options are invalid");
  }
  const endpoint = exactPublicEndpoint(options.sellerPublicEndpoint);
  const directory = resolve(options.directory);
  const filePath = resolve(directory, INDEX_FILE);
  const now = options.now ?? Date.now;
  await ensureSafeDirectory(directory);
  let mutation = Promise.resolve();
  const initialGeneratedAt = now();
  if (!validTimestamp(initialGeneratedAt)) {
    throw new DacsListingDiscoveryStoreError("listing-discovery-clock-invalid");
  }

  async function load(): Promise<DacsListingIndexV1> {
    const text = await readSafeFile(filePath);
    if (text !== undefined) return parseIndex(text, options.sellerAuthority);
    return {
      indexVersion: "1",
      generatedAt: initialGeneratedAt,
      seller: options.sellerAuthority,
      listings: [],
    };
  }

  async function publishActive(
    input: Readonly<DacsListingDiscoveryPublicationInputV1>,
  ): Promise<Readonly<DacsListingDiscoveryPublicationV1>> {
    const entry = entryFor(input);
    if (!sameCanonicalClaimIdentity(input.listing.seller.identity.presentedBy,
      options.sellerAuthority)) {
      throw new TypeError("Listing discovery seller is invalid");
    }
    let resolveResult!: (value: Readonly<DacsListingDiscoveryPublicationV1>) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<Readonly<DacsListingDiscoveryPublicationV1>>((resolvePromise,
      rejectPromise) => {
      resolveResult = resolvePromise;
      rejectResult = rejectPromise;
    });
    mutation = mutation.then(async () => {
      try {
        const current = await load();
        const existing = current.listings.find((candidate) =>
          candidate.listingId === entry.listingId && candidate.version === entry.version);
        if (existing !== undefined) {
          if (canonicalize(existing) !== canonicalize(entry)) {
            resolveResult(Object.freeze({
              status: "conflict",
              reasonCode: "listing-discovery-slot-conflict",
            }));
            return;
          }
          resolveResult(Object.freeze({ status: "existing", indexHash: indexHash(current) }));
          return;
        }
        const generatedAt = now();
        if (!validTimestamp(generatedAt) || generatedAt < current.generatedAt) {
          throw new DacsListingDiscoveryStoreError("listing-discovery-clock-invalid");
        }
        const next: DacsListingIndexV1 = {
          indexVersion: "1",
          generatedAt,
          seller: options.sellerAuthority,
          listings: [...current.listings, entry].sort((left, right) =>
            left.listingId.localeCompare(right.listingId) || left.version - right.version),
        };
        await atomicWrite(filePath, canonicalize(next));
        resolveResult(Object.freeze({ status: "published", indexHash: indexHash(next) }));
      } catch (error) {
        rejectResult(error);
      }
    });
    mutation = mutation.catch(() => undefined);
    return result;
  }

  return Object.freeze({
    publishActive,
    async readIndex() {
      await mutation;
      return Object.freeze(canonicalCopy(await load()));
    },
    async readAgentCard() {
      await mutation;
      const index = await load();
      return Object.freeze({
        dacs: Object.freeze({
          dacsVersion: "1" as const,
          listings: Object.freeze({
            indexUrl: new URL("/.well-known/dacs/listings.json", endpoint).toString(),
            indexHash: indexHash(index),
          }),
        }),
      });
    },
  });
}

/** Serve only the two DACS well-known discovery documents as canonical JSON. */
export function createDacsListingDiscoveryRequestHandlerV1(
  store: Readonly<DacsListingDiscoveryStoreV1>,
): DacsListingDiscoveryRequestHandlerV1 {
  if (store === null || typeof store !== "object" ||
      typeof store.readAgentCard !== "function" || typeof store.readIndex !== "function") {
    throw new TypeError("Listing discovery request handler store is invalid");
  }
  return async (request, response) => {
    if (request.method !== "GET") return false;
    const value = request.url === "/.well-known/agent.json"
      ? await store.readAgentCard()
      : request.url === "/.well-known/dacs/listings.json"
        ? await store.readIndex() : undefined;
    if (value === undefined) return false;
    const body = canonicalize(value);
    response.statusCode = 200;
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("content-length", Buffer.byteLength(body, "utf8"));
    response.end(body);
    return true;
  };
}
