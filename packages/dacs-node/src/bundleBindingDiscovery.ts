import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";

/**
 * One surface a consumer consults to discover signed DACS-5 BundleBindings
 * (BB-2, BB-3, BB-8). A surface only discovers: every record it returns is
 * untrusted and goes through the BB-5..BB-7 candidate set. `discover` throws
 * when the surface did not answer; an empty answer is not absence evidence.
 */
export interface DacsBundleBindingDiscoverySurfaceV1 {
  readonly kind: "well-known" | "catalog" | "demos-binding-program";
  discover(query: Readonly<{
    jobId: string;
    role: "buyer" | "seller";
    signer: string;
  }>): Promise<readonly unknown[]>;
}

export type DacsReadJsonV1 = (url: string) => Promise<unknown>;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function httpsUrl(value: unknown): URL {
  if (typeof value !== "string") throw new TypeError("discovery URL is invalid");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new TypeError("discovery URL must be a credential-free https URL");
  }
  return url;
}

function bindingsOf(document: unknown): readonly unknown[] {
  if (!plainRecord(document) || !Array.isArray(document.bindings)) {
    throw new TypeError("BundleBinding index is malformed");
  }
  return document.bindings;
}

/**
 * DACS-1 §6.3.5: the optional `dacs.bundleBindings` block of a party's
 * `/.well-known/agent.json`, pointing to `{ "bindings": BundleBinding[] }`
 * whose canonical form must match `indexHash`. This SDK uses sha256 of the
 * RFC 8785 canonical index document with a `sha256-` prefix; the pinned Standard
 * leaves that digest computation unspecified. A card without the block
 * answers with no bindings.
 */
export function createWellKnownBundleBindingSurfaceV1(options: Readonly<{
  endpoint: string;
  readJson: DacsReadJsonV1;
}>): Readonly<DacsBundleBindingDiscoverySurfaceV1> {
  const endpoint = httpsUrl(options.endpoint);
  const readJson = options.readJson;
  if (typeof readJson !== "function") throw new TypeError("readJson is required");
  return Object.freeze({
    kind: "well-known" as const,
    async discover() {
      const card = await readJson(new URL("/.well-known/agent.json", endpoint).toString());
      if (plainRecord(card) && !Object.hasOwn(card, "dacs")) return [];
      if (!plainRecord(card) || !plainRecord(card.dacs) || card.dacs.dacsVersion !== "1") {
        throw new TypeError("agent card has no DACS block");
      }
      if (card.dacs.bundleBindings === undefined) return [];
      const block = card.dacs.bundleBindings;
      if (!plainRecord(block) || typeof block.indexHash !== "string" ||
          !/^sha256-[0-9a-f]{64}$/.test(block.indexHash)) {
        throw new TypeError("agent card bundleBindings block is malformed");
      }
      const indexUrl = httpsUrl(block.indexUrl);
      if (indexUrl.origin !== endpoint.origin) {
        throw new TypeError("bundleBindings index is served from another origin");
      }
      const index = await readJson(indexUrl.toString());
      // A stale or substituted index is not an answer.
      if (`sha256-${sha256Hex(canonicalize(index))}` !== block.indexHash) {
        throw new TypeError("bundleBindings index does not match its indexHash");
      }
      return bindingsOf(index);
    },
  });
}

/**
 * DACS-1 §6.3.6: `GET /api/dacs/bundles/{jobId}` on a catalog. The route is
 * absolute, so `catalogUrl` is the catalog's origin; a path, query or fragment
 * would move the Standard's endpoint and is refused.
 */
export function createCatalogBundleBindingSurfaceV1(options: Readonly<{
  catalogUrl: string;
  readJson: DacsReadJsonV1;
}>): Readonly<DacsBundleBindingDiscoverySurfaceV1> {
  const base = httpsUrl(options.catalogUrl);
  if (base.pathname !== "/" || base.search !== "" || base.hash !== "") {
    throw new TypeError(
      "catalogUrl must be an origin without a path, query or fragment, not the catalog's listings URL");
  }
  const readJson = options.readJson;
  if (typeof readJson !== "function") throw new TypeError("readJson is required");
  return Object.freeze({
    kind: "catalog" as const,
    async discover({ jobId }: Readonly<{ jobId: string }>) {
      const url = new URL(`/api/dacs/bundles/${encodeURIComponent(jobId)}`, base.origin);
      return bindingsOf(await readJson(url.toString()));
    },
  });
}
