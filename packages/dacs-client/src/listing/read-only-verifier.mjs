// One exact Listing, verified for display. The Directory row only says where
// to look; the Listing returned is the chain's copy, read from an RPC whose
// genesis identity matches the pin on this very call, and the Standard reader
// must verify it. Nothing here holds a key, signs, writes or admits a purchase.
import { canonicalize, contentHash } from '@kynesyslabs/dacs/listing/read-only';
import { CLAIM, LISTING_ID, createDirectoryClient } from '../dacs/directory.mjs';
import { checkCatalogObservation, displayRailResolution, validateListing } from '../dacs/listing-read-only.mjs';
import { addressForClaim } from '../dacs/read-only-address.mjs';
import { createDemosPublicChainReader } from '../substrate/demos.mjs';
import { RESPONSE_BYTE_LIMIT, settleOnAbort } from '../util/http.mjs';
import {
  LISTING_CALL_TIMEOUT_MS, LISTING_CHAIN_IDENTITY_MAX_BYTES, LISTING_CHAIN_TIMEOUT_MS, LISTING_DIRECTORY_DETAIL_MAX_BYTES,
  LISTING_DIRECTORY_PAGE_MAX_BYTES, LISTING_DIRECTORY_TIMEOUT_MS, LISTING_MAX_FETCHES, LISTING_STORAGE_MAX_BYTES,
} from './read-only-limits.mjs';

const TESTNET = 'testnet';
const PIN = /^[0-9a-f]{64}$/;
// What an unexplained failure means at each stage of a lookup.
const STAGE_REASONS = Object.freeze({
  directory: 'listing_directory_unavailable',
  identity: 'listing_chain_identity_mismatch',
  anchor: 'listing_anchor_mismatch',
  standard: 'listing_standard_invalid',
});

/**
 * The one error a read-only Listing lookup throws: `code` is always
 * `listing_read_unavailable` and `reason` (also the message) one of
 * listing_input_invalid, listing_not_found, listing_directory_unavailable,
 * listing_read_timeout, listing_read_limit, listing_chain_identity_mismatch,
 * listing_anchor_mismatch, listing_catalog_stale or listing_standard_invalid.
 * It carries no cause and no upstream text.
 */
export class ReadOnlyListingError extends Error {
  constructor(reason) {
    super(reason);
    this.code = 'listing_read_unavailable';
    this.reason = reason;
  }
}
ReadOnlyListingError.prototype.name = 'ReadOnlyListingError';

const refuse = (reason) => { throw new ReadOnlyListingError(reason); };

const isOrigin = (value) => typeof value === 'string' && URL.canParse(value) && new URL(value).origin === value && ['http:', 'https:'].includes(new URL(value).protocol);
const isHttpUrl = (value) => typeof value === 'string' && URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol);

function assertOptions({ directoryOrigin, rpcUrl, network, pinnedIdentity, directoryFetchImpl, chainFetchImpl, now }) {
  const valid = isOrigin(directoryOrigin) && isHttpUrl(rpcUrl) && network === TESTNET && typeof pinnedIdentity === 'string' && PIN.test(pinnedIdentity)
    && [directoryFetchImpl, chainFetchImpl, now].every((value) => typeof value === 'function');
  if (!valid) refuse('listing_input_invalid');
}

function assertCoordinates({ listingId, version, seller, fresh = true }) {
  const valid = typeof listingId === 'string' && LISTING_ID.test(listingId) && Number.isSafeInteger(version) && version > 0
    && typeof seller === 'string' && CLAIM.test(seller) && fresh === true;
  if (!valid) refuse('listing_input_invalid');
}

// False instead of throwing for a value that cannot be canonicalized.
function sameCanonical(left, right) {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
}

function hashOf(value) {
  try {
    return contentHash(value);
  } catch {
    return null;
  }
}

const namesListing = (value, { listingId, version, seller }) =>
  value?.listingId === listingId && value.listingVersion === version && value.seller?.identity?.presentedBy === seller;

// The public reason for a failure, from the call's own state first, then the error's kind, then the stage it happened in.
function reasonFor(error, { budget, deadline, stage }) {
  if (budget.spent) return 'listing_read_limit';
  if (deadline.aborted) return 'listing_read_timeout';
  if (error instanceof ReadOnlyListingError) return error.reason;
  if (error?.kind === 'timeout') return 'listing_read_timeout';
  if (error?.code === RESPONSE_BYTE_LIMIT) return 'listing_read_limit';
  if (error?.code === 'network_identity_mismatch') return 'listing_chain_identity_mismatch';
  if (error?.code === 'directory_row_malformed' && error.member === 'catalogObservedAt') return 'listing_catalog_stale';
  return STAGE_REASONS[stage];
}

// A fetch that counts against the call's shared budget and also stops when the call's deadline passes.
function budgetedFetch(fetchImpl, budget, deadline) {
  return async (input, init = {}) => {
    deadline.throwIfAborted();
    budget.used += 1;
    if (budget.used > LISTING_MAX_FETCHES) {
      budget.spent = true;
      throw new RangeError('the read budget of this Listing lookup is spent');
    }
    return fetchImpl(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline });
  };
}

/**
 * Creates a verifier that checks one exact Listing at a time, for display
 * only. Each `verify` call builds its own Directory client and pinned testnet
 * chain reader over `directoryFetchImpl` and `chainFetchImpl`, which share
 * one budget of LISTING_MAX_FETCHES requests and one LISTING_CALL_TIMEOUT_MS
 * deadline. `pinnedIdentity` is the testnet genesis identity, 64 lowercase hex.
 * Both fetch functions default to the global `fetch`, and `now` to Date.now.
 *
 * `verify({listingId, version, seller, fresh = true})` resolves a frozen
 * `{listingId, version, seller, listing, contentHash, anchor, checkedAt,
 * disposition: 'verified'}`, where `listing` is the chain readback. It says
 * nothing about whether the Listing can be purchased. `fresh: false` is
 * refused: every answer is read afresh.
 *
 * The factory throws, and `verify` rejects with, ReadOnlyListingError.
 */
export function createReadOnlyListingVerifier(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) refuse('listing_input_invalid');
  const { directoryFetchImpl = globalThis.fetch, chainFetchImpl = globalThis.fetch, now = () => Date.now(), ...endpoints } = options;
  const { directoryOrigin, rpcUrl, pinnedIdentity } = endpoints;
  assertOptions({ ...endpoints, directoryFetchImpl, chainFetchImpl, now });

  async function lookup(coordinates, call) {
    const { listingId, version, seller } = coordinates;
    const checkedAt = now();
    const directory = createDirectoryClient({ origin: directoryOrigin, timeoutMs: LISTING_DIRECTORY_TIMEOUT_MS, maxBytes: LISTING_DIRECTORY_PAGE_MAX_BYTES,
      detailMaxBytes: LISTING_DIRECTORY_DETAIL_MAX_BYTES, fetchImpl: budgetedFetch(directoryFetchImpl, call.budget, call.deadline) });
    const chain = createDemosPublicChainReader({ rpcUrl, network: TESTNET, pinnedIdentity, timeoutMs: LISTING_CHAIN_TIMEOUT_MS,
      identityMaxBytes: LISTING_CHAIN_IDENTITY_MAX_BYTES, storageMaxBytes: LISTING_STORAGE_MAX_BYTES, fetchImpl: budgetedFetch(chainFetchImpl, call.budget, call.deadline) });

    call.stage = 'directory';
    const summary = await directory.findSummary(coordinates) ?? refuse('listing_not_found');
    const detail = await directory.getListingDetail(coordinates);
    if (hashOf(detail) !== summary.contentHash || !namesListing(detail, coordinates)) refuse('listing_anchor_mismatch');
    const { observedAt, fresh } = checkCatalogObservation(summary.catalogObservedAt, checkedAt);
    if (!fresh) refuse('listing_catalog_stale');

    call.stage = 'identity';
    await chain.networkIdentity();
    call.stage = 'anchor';
    const readback = await chain.readStorageProgram(summary.anchor.locator);
    const anchored = readback.status === 'found' && readback.owner === addressForClaim(seller) && sameCanonical(readback.data, detail)
      && hashOf(readback.data) === summary.contentHash && namesListing(readback.data, coordinates);
    if (!anchored) refuse('listing_anchor_mismatch');

    call.stage = 'standard';
    let markerReads = 0;
    let markerFailure = null;
    const standard = await validateListing(readback.data, {
      now: () => checkedAt,
      loadRailResolution: displayRailResolution,
      revocationSurfaces: [{ kind: 'catalog', status: summary.status, readStatus: 'ok', catalogObservedAt: observedAt, ...(summary.revocation ? { binding: summary.revocation } : {}) }],
      // One marker read at most; a marker that is not found is no proof either way.
      readMarker: async (anchor) => {
        markerReads += 1;
        if (anchor?.kind !== 'storage-program' || markerReads > 1) return null;
        try {
          const marker = await chain.readStorageProgram(anchor.locator);
          return marker.status === 'found' ? marker.data : null;
        } catch (error) {
          markerFailure = error;
          throw error;
        }
      },
    });
    if (markerFailure) throw markerFailure;
    if (standard.disposition !== 'verified') refuse('listing_standard_invalid');
    return Object.freeze({ listingId, version, seller, listing: readback.data, contentHash: summary.contentHash,
      anchor: Object.freeze({ kind: summary.anchor.kind, locator: summary.anchor.locator }), checkedAt, disposition: 'verified' });
  }

  async function verify(input) {
    assertCoordinates(input ?? {});
    const { listingId, version, seller } = input;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LISTING_CALL_TIMEOUT_MS);
    const call = { budget: { used: 0, spent: false }, deadline: controller.signal, stage: 'directory' };
    try {
      // A request that ignores its signal cannot hold the call past its deadline; a result it brings later is dropped.
      return await settleOnAbort(lookup({ listingId, version, seller }, call), controller.signal);
    } catch (error) {
      throw new ReadOnlyListingError(reasonFor(error, call));
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  return Object.freeze({ verify });
}
