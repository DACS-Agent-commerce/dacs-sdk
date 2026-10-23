// Read-only Demos chain access. No keys, no writes, no broadcasts.
//
// Provenance: the RPC surface follows Community dacs-directory@074f040
// src/catalog/chain.ts (GET {rpc}/storage-program/{stor-…}) and the SDK's
// createPayDemSellerObserver nodeCall protocol (POST {rpc} {method:"nodeCall",
// params:[{message,data}]} -> {result:200,response}). Transfer observation is
// delegated to the SDK's observePayDemTransferCore.
import { createPayDemSellerObserver } from '@kynesyslabs/dacs/seller';
import { DEMOS_CCI_RESPONSE_LIMITS, assertDemosCciResponseBounds } from '@kynesyslabs/dacs/identity';
import { fetchBoundedJson, OutboundError } from '../util/http.mjs';
import { normalizeDemosAddress } from '../signatures.mjs';

const LOCATOR = /^stor-[0-9a-f]{40}$/;
const CHAIN_IDENTITY = /^(?:0x)?([0-9a-f]{64})$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// A fixture endpoint advertises itself with this header; evidence read from it
// is labelled simulated and can never be reported as live chain evidence.
export const SIMULATION_HEADER = 'x-dacs-simulation';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const DEM_DECIMALS = 9;
const OS_PER_DEM = 1_000_000_000n;
// The most digits an exact OS amount read from the node may have (enough for
// 2^256 - 1). Balances are read up to this length.
export const OS_DIGITS_MAX = 78;
// The largest payment this client can verify. A Demos node projects a
// transaction's content.amount as a JSON number (node2: "amount":2400000000000),
// and every RPC answer passes CF-5 admission (util/http.mjs), which refuses a
// number above 2^53 - 1. A larger price could be paid but never verified, so
// listing prices (listing.mjs normalizeDemAmount) stop here.
export const OS_VERIFIABLE_MAX = BigInt(Number.MAX_SAFE_INTEGER);
// A canonical OS integer of at most OS_DIGITS_MAX digits.
export const OS_INTEGER = new RegExp(`^(?:0|[1-9][0-9]{0,${OS_DIGITS_MAX - 1}})$`);
// A canonical DEM decimal whose exact OS amount fits OS_DIGITS_MAX digits.
export const DEM_DECIMAL = new RegExp(`^(0|[1-9][0-9]{0,${OS_DIGITS_MAX - DEM_DECIMALS - 1}})(?:\\.([0-9]{1,${DEM_DECIMALS}}))?$`);

// Node builds differ between a bare number and {nonce}; anything else fails closed.
export function nonceFromNode(response) {
  const value = typeof response === 'number' ? response : response?.nonce;
  if (!Number.isSafeInteger(value) || value < 0) throw new OutboundError('invalid', 'nonce response is malformed');
  return value;
}

// A transaction body's content.nonce as the node projects it: a safe
// non-negative JSON integer, or its canonical decimal text (node2 serves
// "nonce":"198"). No whitespace, sign, fraction, exponent, leading zero or
// unsafe value is coerced; anything else is null (unreadable, not different).
export function nodeProjectedNonce(value) {
  const nonce = typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(nonce) && nonce >= 0 && !Object.is(nonce, -0) ? nonce : null;
}

// An account balance as the node carries it, converted exactly to OS, or null.
// os-string (post denomination fork): integer OS as a canonical decimal string
// (live Node2 2026-10-08: "2481500000000") or a safe non-negative JSON integer.
// dem-number (pre-fork): DEM as a safe non-negative JSON integer or a canonical
// decimal string with at most 9 fractional digits. Nothing is rounded.
export function balanceOsFromNode(value, encoding) {
  if (encoding === 'os-string') {
    if (typeof value === 'string') return OS_INTEGER.test(value) ? BigInt(value) : null;
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (encoding === 'dem-number') {
    if (typeof value === 'string') {
      const match = DEM_DECIMAL.exec(value);
      return match ? BigInt(match[1]) * OS_PER_DEM + BigInt((match[2] ?? '').padEnd(9, '0')) : null;
    }
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) * OS_PER_DEM : null;
  }
  return null;
}

const chainIdentityOf = (value) => (typeof value === 'string' ? CHAIN_IDENTITY.exec(value.trim().toLowerCase())?.[1] ?? null : null);

export function createDemosChainReader({ rpcUrl, network, pinnedIdentity = null, timeoutMs = 10000, fetchImpl = globalThis.fetch }) {
  const base = rpcUrl.replace(/\/$/, '');
  const origin = new URL(base).origin;
  const loopback = LOOPBACK_HOSTS.has(new URL(base).hostname);
  let simulated = false;

  const observingFetch = async (input, init) => {
    const response = await fetchImpl(input, { ...init, redirect: 'manual', credentials: 'omit' });
    if (response.headers.get(SIMULATION_HEADER)) simulated = true;
    return response;
  };

  function nodePayload(message, data, fetcher = observingFetch) {
    return fetchBoundedJson(base, {
      fetchImpl: fetcher,
      method: 'POST',
      body: { method: 'nodeCall', params: [{ message, data }] },
      timeoutMs,
      maxBytes: 4 * 1024 * 1024,
      expectedOrigin: origin,
    });
  }

  async function nodeCall(message, data) {
    const payload = await nodePayload(message, data);
    if (!payload || payload.result !== 200 || !Object.hasOwn(payload, 'response')) {
      throw new OutboundError('unavailable', `Demos RPC ${message} returned a non-200 result`);
    }
    return payload.response;
  }

  // One block read with this answer's own simulation marker. A non-200 answer
  // is no block (some nodes answer block zero with an error); a failed
  // request still throws.
  async function blockRead(blockNumber) {
    let marked = false;
    const payload = await nodePayload('getBlockByNumber', { blockNumber }, async (input, init) => {
      const response = await observingFetch(input, init);
      marked = Boolean(response.headers.get(SIMULATION_HEADER));
      return response;
    });
    const answered = isRecord(payload) && payload.result === 200 && Object.hasOwn(payload, 'response');
    return { block: answered && isRecord(payload.response) ? payload.response : null, marked };
  }

  // The configured RPC's chain identity, read as the pinned @kynesyslabs/dacs
  // DemosAdapter.resolveChainIdentity reads it: the genesis block hash (block
  // 0, number 0 or absent), else block 1's content.previousHash when block 1 is
  // confirmed. A loopback RPC whose answer carries the simulation marker is a
  // simulated fixture without a real chain identity and is reported as such.
  // This is one RPC's answer: it exposes a wrong network behind an honest RPC,
  // not a dishonest RPC. Nothing here is carried in a signed transaction.
  async function networkIdentity() {
    const zero = await blockRead(0);
    if (loopback && zero.marked) return { mode: 'simulated-fixture', identity: null };
    const genesisNumber = zero.block ? zero.block.number ?? zero.block.id : undefined;
    let identity = zero.block && (genesisNumber === undefined || genesisNumber === 0) ? chainIdentityOf(zero.block.hash) : null;
    if (!identity) {
      const { block } = await blockRead(1);
      if (block?.number === 1 && block.status === 'confirmed' && typeof block.hash === 'string' && block.hash.trim() && isRecord(block.content)) {
        identity = chainIdentityOf(block.content.previousHash);
      }
    }
    if (!identity) throw new OutboundError('invalid', 'the configured Demos RPC reported no genesis chain identity');
    return { mode: 'public-chain-read', identity };
  }

  async function readStorageProgram(locator) {
    if (!LOCATOR.test(locator)) throw new OutboundError('invalid', 'storage program locator is malformed');
    let body;
    try {
      body = await fetchBoundedJson(`${base}/storage-program/${locator}`, {
        fetchImpl: observingFetch,
        timeoutMs,
        maxBytes: 256 * 1024,
        expectedOrigin: origin,
      });
    } catch (error) {
      // CORE §5.1: the node's 404 carries no authenticated absence proof, so
      // a non-observation is indeterminate, never absent.
      if (error.kind === 'not-found') return { status: 'indeterminate', reason: 'the node did not return this storage program; not-found is not proof of absence' };
      throw error;
    }
    if (body?.success !== true || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
      return { status: 'indeterminate', reason: 'the node returned no storage program data' };
    }
    return {
      status: 'found',
      data: body.data,
      owner: typeof body.owner === 'string' ? body.owner.toLowerCase() : null,
      programName: typeof body.programName === 'string' ? body.programName : null,
    };
  }

  // Exact account nonce. Errors propagate (never coerced to 0) so an
  // unavailable node cannot masquerade as "nothing was broadcast".
  async function getAddressNonce(address) {
    const response = await nodeCall('getAddressNonce', { address: normalizeDemosAddress(address) });
    return nonceFromNode(response);
  }

  async function getTransaction(hash) {
    return nodeCall('getTxByHash', { hash });
  }

  // Exact account balance in OS, read as the deployment's
  // DACS_DEM_AMOUNT_ENCODING says the node carries amounts (see
  // balanceOsFromNode). Anything inexact fails closed.
  async function getAddressBalance(address, { encoding = 'os-string' } = {}) {
    const response = await nodeCall('getAddressInfo', { address: normalizeDemosAddress(address) });
    const balance = isRecord(response) ? balanceOsFromNode(response.balance, encoding) : null;
    if (balance === null) throw new OutboundError('invalid', `balance response has no exact non-negative ${encoding} amount`);
    return balance;
  }

  // One native action's buyer cost in OS: the SDK's 1 DEM gas plus the node's
  // networkFee, rpcFee and additionalFee (whole DEM; additionalFee is 0 when
  // the node omits it). Live Node2 (2026-10-08) answers
  // {networkFee:1, rpcFee:1, additionalFee:0, ...}.
  async function getTransactionFees() {
    const response = await nodeCall('getNetworkParameters', {});
    const whole = (key) => Number.isSafeInteger(response[key]) && response[key] >= 0;
    if (!isRecord(response) || !['networkFee', 'rpcFee'].every(whole) || (Object.hasOwn(response, 'additionalFee') && !whole('additionalFee'))) {
      throw new OutboundError('invalid', 'network fees must be exact non-negative whole DEM amounts');
    }
    const additionalFee = Object.hasOwn(response, 'additionalFee') ? response.additionalFee : 0;
    return (1n + BigInt(response.networkFee) + BigInt(response.rpcFee) + BigInt(additionalFee)) * OS_PER_DEM;
  }

  // Unified identity read, aligned with the pinned consumer: the vendored
  // @kynesyslabs/dacs 0.1.0-alpha.0 DemosAdapter.resolveIdentity calls demosdk
  // Identities.getIdentities(demos, "getIdentities", ref), which posts
  // {method:"gcr_routine", params:[{method:"getIdentities", params:[address]}]}
  // and returns the decoded {result, response, ...} envelope; dacs then bounds
  // that whole decoded value with assertDemosCciResponseBounds before
  // projecting it with parseCciRecord. Here: the transport is capped at
  // DEMOS_CCI_RESPONSE_LIMITS.maxEncodedBytes before decoding, a non-200
  // result is unavailable (never "no identities"), and the same decoded-value
  // bound is applied before returning the envelope.
  //
  // Request headers: pinned demosdk 4.0.16 (the dacs peer range ^4.0.16 and the
  // embedded wallet's runtime) calls rpcCall(request, demos.walletConnected),
  // so without a wallet it sends the read UNSIGNED, with the auth headers
  // present but empty: identity "ed25519:", signature "", timestamp "". This
  // reader holds no key and sends exactly that unsigned shape; it signs
  // nothing. (Older 4.0.12 source signed every call.) Whether a given live
  // Demos node answers this unsigned read is NOT verified here.
  const UNSIGNED_SDK_HEADERS = Object.freeze({ identity: 'ed25519:', signature: '', timestamp: '' });
  async function getIdentities(address, { timeoutMs: readTimeoutMs = timeoutMs } = {}) {
    const payload = await fetchBoundedJson(base, {
      fetchImpl: observingFetch,
      method: 'POST',
      body: { method: 'gcr_routine', params: [{ method: 'getIdentities', params: [normalizeDemosAddress(address)] }] },
      headers: UNSIGNED_SDK_HEADERS,
      timeoutMs: Math.min(timeoutMs, readTimeoutMs),
      maxBytes: DEMOS_CCI_RESPONSE_LIMITS.maxEncodedBytes,
      expectedOrigin: origin,
    });
    if (!payload || typeof payload !== 'object' || payload.result !== 200 || !Object.hasOwn(payload, 'response')) {
      throw new OutboundError('unavailable', 'Demos RPC gcr_routine getIdentities returned a non-200 result');
    }
    try {
      assertDemosCciResponseBounds(payload);
    } catch (error) {
      throw new OutboundError('invalid', `getIdentities response rejected: ${String(error?.message ?? error).slice(0, 120)}`);
    }
    return payload;
  }

  const observer = createPayDemSellerObserver({ rpc: base, timeoutMs, maxResponseBytes: 4 * 1024 * 1024, fetchImpl: observingFetch });

  return {
    network,
    observer: '@kynesyslabs/dacs observePayDemTransferCore (single-node consistent view; not a validator-quorum proof)',
    rpcOrigin: origin,
    // Source-pinned expected chain identity (src/config.mjs), or null.
    pinnedIdentity: chainIdentityOf(pinnedIdentity),
    get evidenceMode() {
      return simulated ? 'simulated-fixture' : 'public-chain-read';
    },
    networkIdentity,
    readStorageProgram,
    getAddressNonce,
    getAddressBalance,
    getTransactionFees,
    getTransaction,
    getIdentities,
    observeTransfer: (hash) => observer.observeDemosTransfer(hash),
  };
}
