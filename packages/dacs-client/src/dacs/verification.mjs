import { createImmutableReadbacks } from '../util/immutable-readbacks.mjs';
import { RawJsonAdmissionError } from '@kynesyslabs/dacs';
// Independent listing verification: directory hint -> chain readback -> SDK reader.
// A listing is transactable only when every check passes; each check is
// reported explicitly so the model (and user) can see exactly what held.
import { canonicalize, contentHash, validateListing, purchaseSupport, SDK_PROVENANCE } from './listing.mjs';
import { addressForClaim } from '../signatures.mjs';
import { normalizeCatalogObservedAt } from './directory.mjs';

export class NotConfiguredError extends Error {
  constructor(dependency) {
    super(`${dependency} is not configured on this server`);
    this.code = 'not_configured';
    this.dependency = dependency;
  }
}

const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function checkCatalogObservation(value, checkedAt) {
  const observedAt = normalizeCatalogObservedAt(value);
  const fresh = observedAt !== undefined && observedAt <= checkedAt && checkedAt - observedAt <= CATALOG_MAX_AGE_MS;
  return { observedAt, fresh };
}

// cacheImmutable: within one purchase, a transactable Listing's chain bytes
// may be reused for a short TTL (createImmutableReadbacks), keyed by the
// purchase, the anchor locator and the content hash the chain bytes were
// verified to have. A changed directory detail is a different key; `fresh`
// (the authoritative handoff check) always re-reads the chain, and a fresh
// read that no longer verifies evicts the entry. Directory, revocation,
// validity and source admission are checked on every call.
export function createListingVerifier({ directory, chain, now = () => Date.now(), cacheImmutable = false, observeBinding = null }) {
  const immutable=createImmutableReadbacks({ now });
  async function verify({ listingId, version, seller, purchaseId, fresh = false }) {
    if (!directory) throw new NotConfiguredError('DACS directory (DACS_DIRECTORY_ORIGIN)');
    if (!chain) throw new NotConfiguredError('Demos chain RPC (DACS_CHAIN_RPC_URL)');
    const checkedAt = now();
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok, ...(detail ? { detail } : {}) });

    const summary = await directory.findSummary({ listingId, version, seller });
    if (!summary) {
      return { listingId, version, seller, transactable: false, eligibility: 'not-transactable', disposition: 'not-found', standardReaderInput: null, checks: [{ name: 'directory-summary', ok: false, detail: 'listing not in directory catalog' }] };
    }
    const detail = await directory.getListingDetail({ listingId, version, seller });
    const detailHash = contentHash(detail);
    add('directory-detail-hash-matches-summary', detailHash === summary.contentHash, detailHash === summary.contentHash ? undefined : 'directory detail differs from its own summary');
    add('directory-coordinates-match', detail.listingId === listingId && detail.listingVersion === version && detail.seller?.identity?.presentedBy === seller);

    // Transactable implies contentHash(chain bytes) === detailHash, so the key
    // names the exact verified bytes at this locator.
    const cacheable=cacheImmutable&&Boolean(purchaseId);
    const cacheKey={purchaseId,locator:summary.anchor.locator,contentHash:detailHash,scope:{seller,listingId,version}};
    let readback=cacheable&&!fresh?immutable.get(cacheKey):null;
    const reused=Boolean(readback);
    try {
      if(reused)await observeBinding?.();
      readback ??= await chain.readStorageProgram(summary.anchor.locator);
    } catch (error) {
      // CF-5 rejection is an invalid artifact, not a transport outage. Preserve
      // its code and stage before the SDK's later live-profile gate can run.
      if (error instanceof RawJsonAdmissionError || error?.cause instanceof RawJsonAdmissionError) throw error;
      readback = { status: 'unavailable', reason: error.message };
    }
    const sellerAddress = addressForClaim(seller);
    const onChain = readback.status === 'found';
    add('chain-anchor-present', onChain, onChain ? undefined : `storage program ${readback.status}`);
    const readbackMatches = onChain && canonicalize(readback.data) === canonicalize(detail);
    add('chain-readback-equals-directory-detail', readbackMatches);
    const ownerMatches = onChain && readback.owner === sellerAddress;
    add('chain-anchor-owner-is-seller', ownerMatches, onChain && !ownerMatches ? 'anchor owner differs from the seller key' : undefined);

    // From here on only the chain bytes are trusted, never directory bytes.
    const listing = onChain ? readback.data : detail;
    const { observedAt, fresh: catalogFresh } = checkCatalogObservation(summary.catalogObservedAt, checkedAt);
    add('catalog-observation-fresh', catalogFresh, catalogFresh ? undefined : 'catalog observation older than 24h, in the future or missing; revocation absence cannot be established');
    const surfaces = [{ kind: 'catalog', status: summary.status, readStatus: 'ok', ...(observedAt !== undefined ? { catalogObservedAt: observedAt } : {}), ...(summary.revocationBinding ? { binding: summary.revocationBinding } : {}) }];
    const standard = await validateListing(listing, {
      now: () => checkedAt,
      revocationSurfaces: surfaces,
      readMarker: async (anchor) => {
        if (anchor?.kind !== 'storage-program') return null;
        const marker = await chain.readStorageProgram(anchor.locator);
        return marker.status === 'found' ? marker.data : null;
      },
    });
    add('standard-reader-verified', standard.disposition === 'verified', `${standard.disposition} at step ${standard.step}: ${standard.reason}`);
    const support = purchaseSupport(listing);
    add('v0.1-purchase-support', support.supported, support.supported ? undefined : support.reasons.join('; '));

    const transactable = checks.every((c) => c.ok);
    if(cacheable&&!reused) {
      if(transactable) immutable.put(cacheKey,readback);
      else if(readback.status!=='unavailable') immutable.delete(cacheKey);
    }
    // Application eligibility is separate from the SDK reader's disposition:
    // the reader can return `verified` for the bytes it was given while the
    // chain or ownership checks still fail. Neither weakens the other.
    const eligibility = transactable ? 'transactable' : 'not-transactable';
    const standardReaderInput = onChain ? 'chain-readback' : 'directory-detail-unanchored';
    return {
      listingId,
      version,
      seller,
      contentHash: onChain ? contentHash(readback.data) : detailHash,
      anchor: summary.anchor,
      disposition: standard.disposition,
      eligibility,
      standardReaderInput,
      revocation: standard.revocation ?? null,
      transactable,
      checks,
      validity: listing.validity ?? null,
      price: support.price,
      payee: support.payee,
      listing: transactable ? listing : undefined,
      evidence: {
        directoryOrigin: directory.origin,
        directoryMode: directory.evidenceMode,
        chainRpcOrigin: chain.rpcOrigin,
        chainNetwork: chain.network,
        chainMode: chain.evidenceMode,
        checkedAt: new Date(checkedAt).toISOString(),
        sdk: SDK_PROVENANCE,
        note: 'Directory results are discovery hints; transactable requires the storage-program readback, seller ownership and the SDK reader to agree.',
      },
    };
  }
  return { verify };
}
