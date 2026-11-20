// Read-only, injectable Demos network binding. This module has no fetch, wallet,
// signer or broadcaster and does not enable any payment profile.
//
// Integration contract: `expected` comes from independently reviewed source
// pins, never from the observed node or a global network label. `reader` is the
// trusted transport owner. Its getContext() returns the actual active network,
// exact endpoint, transportAuthority identifier and reconnect connectionId.
// getBlockByNumber(height, policy) must honor no-store/error-on-redirect, bound
// its decoded response and enforce its own transport cancellation policy, then
// return { value: <SDK getBlockByNumber material>, context, observedAt,
//          fromCache: false, redirected: false } for that actual request.
// `value` can be a direct block or the SDK {result:200,response:<block>} shape.
// The one exception is the string "0" genesis read: its `value` must be the exact
// four-field envelope {result:200,response:{number:0,hash},require_reply:false,extra:""},
// never a bare block or a two-field envelope.
// A reader used with a stabilised genesis also has getChainIdentity(policy), which
// returns the same receipt around the node's exact `getChainIdentity` envelope.
// A transport cannot establish its authority by copying the expected values;
// the caller must bind this receipt to its actual egress/connection state.
//
// Persist returned records in the operation journal. Recheck after endpoint or
// connection changes, and use beforeSignature/beforeBroadcast immediately at
// each respective consumer fence. They always read again. Recovery records are
// comparison material, not execution permits; recover() always observes anew.
// These methods do not make the later sign/broadcast atomic. The transport
// owner must hold its connection/endpoint fence through those external actions.
import { createHash } from 'node:crypto';
import { types } from 'node:util';

export const DEMOS_NETWORK_BINDING_VERSION = 'dacs-demos-network-binding/v1';
const HASH = /^(?:0x)?([0-9a-f]{64})$/;
const NETWORK = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const EXPECTED_KEYS = ['network', 'chainIdentity', 'pinVersion', 'endpoint', 'transportAuthority'];
const CONTEXT_KEYS = ['network', 'endpoint', 'transportAuthority', 'connectionId'];
const RECORD_KEYS = ['bindingVersion', 'bindingId', ...EXPECTED_KEYS, 'connectionId', 'source', 'observedAt', 'expiresAt'];
const STABILISED_GENESIS_REPRESENTATION = 'stabilised-genesis';
const STABILISED_GENESIS_KEYS = ['representation', 'documentation', 'chainId', 'genesisHash', 'genesisDataHash', 'blockOneHash'];

export class NetworkBindingError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'NetworkBindingError';
    this.code = code;
  }
}

const fail = (code, message, cause) => { throw new NetworkBindingError(code, message, cause === undefined ? undefined : { cause }); };
const exactMatch = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;

function record(value, code = 'malformed_observation') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail(code, 'A plain data record is required');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !Object.hasOwn(descriptors[key], 'value'))) {
    fail(code, 'Accessor and symbolic data are not accepted');
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, entry]) => [key, entry.value]));
}

function exactKeys(value, keys, code) {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    fail(code, 'The record schema is not exact');
  }
}

function identity(value, code = 'malformed_observation') {
  const match = typeof value === 'string' ? HASH.exec(value) : null;
  if (!match || match[0] !== value) fail(code, 'Chain identity must be canonical lowercase 64-hex material');
  return match[1];
}

function endpoint(value, code) {
  let parsed;
  try { parsed = new URL(value); } catch { fail(code, 'A canonical HTTPS endpoint is required'); }
  if (typeof value !== 'string' || parsed.href !== value || parsed.protocol !== 'https:'
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail(code, 'A canonical HTTPS endpoint without credentials, query or fragment is required');
  }
  return value;
}

function identifier(value, code) {
  if (!exactMatch(IDENTIFIER, value)) fail(code, 'A bounded authority or version identifier is required');
  return value;
}

function timestamp(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code, 'A positive safe-integer timestamp is required');
  return value;
}

function contextOf(value) {
  const context = record(value, 'transport_mismatch');
  exactKeys(context, CONTEXT_KEYS, 'transport_mismatch');
  if (!exactMatch(NETWORK, context.network)) fail('transport_mismatch', 'Transport network label is malformed');
  endpoint(context.endpoint, 'transport_mismatch');
  identifier(context.transportAuthority, 'transport_mismatch');
  identifier(context.connectionId, 'transport_mismatch');
  return Object.freeze(context);
}

function sameContext(left, right) {
  return CONTEXT_KEYS.every((key) => left[key] === right[key]);
}

function bindingId(expected) {
  return createHash('sha256').update(JSON.stringify([
    DEMOS_NETWORK_BINDING_VERSION, ...EXPECTED_KEYS.map((key) => expected[key]),
  ])).digest('hex');
}

function sdkValue(value) {
  if (value === 'error') return value;
  const data = record(value);
  if (Object.hasOwn(data, 'response')) {
    if (Object.hasOwn(data, 'result') && data.result !== 200) fail('unavailable', 'The SDK read did not return result 200');
    if (['hash', 'number', 'id', 'status', 'content', 'chainIdentity', 'genesisHash'].some((key) => Object.hasOwn(data, key))) {
      fail('ambiguous_observation', 'Block data conflicts with the SDK response envelope');
    }
    return data.response === 'error' ? 'error' : record(data.response);
  }
  if (Object.hasOwn(data, 'result')) fail('malformed_observation', 'The SDK result has no response');
  return data;
}

function exactHeight(block, height) {
  const heights = ['number', 'id'].filter((key) => Object.hasOwn(block, key)).map((key) => block[key]);
  if (heights.length === 0 || heights.some((value) => value !== height)
    || (height === 1 && block.number !== 1)) fail('wrong_block', 'Block height is absent, conflicting or incorrect');
  if (block.status !== 'confirmed') fail('wrong_block', 'The identity block is not confirmed');
}

// The response of an exact successful node RPC envelope.
function exactRpcResponse(value) {
  const envelope = record(value);
  exactKeys(envelope, ['result', 'response', 'require_reply', 'extra'], 'malformed_observation');
  if (envelope.result !== 200) fail('unavailable', 'The read did not return result 200');
  if (envelope.require_reply !== false || envelope.extra !== '') fail('malformed_observation', 'The RPC envelope is not the node\'s exact success envelope');
  return record(envelope.response);
}

function bareHash(value) {
  if (identity(value) !== value) fail('malformed_observation', 'A canonical bare lowercase hash is required');
  return value;
}

// The recorded answer to a string `"0"` block request: an exact successful RPC
// envelope whose response is only the genesis number and hash. It has no
// `status`, so `exactHeight` does not apply to it.
function genesisProjection(value) {
  const genesis = exactRpcResponse(value);
  exactKeys(genesis, ['number', 'hash'], 'malformed_observation');
  if (genesis.number !== 0) fail('wrong_block', 'The genesis projection must name numeric block zero');
  bareHash(genesis.hash);
  return genesis;
}

// The node's `getChainIdentity` answer: `{ chainId, genesisHash, genesisDataHash }` in the exact RPC envelope.
function chainIdentityAnswer(value) {
  const answer = exactRpcResponse(value);
  exactKeys(answer, ['chainId', 'genesisHash', 'genesisDataHash'], 'malformed_observation');
  if (answer.chainId !== null && typeof answer.chainId !== 'string') fail('malformed_observation', 'The chain id must be text or null');
  bareHash(answer.genesisHash);
  bareHash(answer.genesisDataHash);
  return answer;
}

// Confirmed block one's predecessor: the genesis hash its content names, which no alias on the block may contradict.
function blockOnePredecessor(block) {
  exactHeight(block, 1);
  const predecessor = identity(record(block.content).previousHash);
  exactAliases(block, predecessor);
  if (Object.hasOwn(block, 'previousHash') && identity(block.previousHash) !== predecessor) fail('conflicting_identity', 'Block predecessor aliases conflict');
  return predecessor;
}

function exactAliases(block, expectedIdentity) {
  for (const key of ['chainIdentity', 'genesisHash']) {
    if (Object.hasOwn(block, key) && identity(block[key]) !== expectedIdentity) {
      fail('conflicting_identity', 'Block identity aliases conflict');
    }
  }
}

// The reviewed values of a stabilised genesis, as the pin states them. Every field is required.
function stabilisedGenesisPolicy(value, expected) {
  const policy = record(value, 'invalid_policy');
  exactKeys(policy, STABILISED_GENESIS_KEYS, 'invalid_policy');
  if (policy.representation !== STABILISED_GENESIS_REPRESENTATION) fail('invalid_policy', 'The genesis representation is not one this binder reads');
  if (typeof policy.documentation !== 'string' || !policy.documentation.trim() || policy.documentation.length > 512) {
    fail('invalid_policy', 'A stabilised genesis requires a reviewed reference');
  }
  if (policy.chainId !== null && (typeof policy.chainId !== 'string' || !policy.chainId.trim() || policy.chainId.length > 160)) {
    fail('invalid_policy', 'The reviewed chain id must be bounded text or null');
  }
  for (const key of ['genesisHash', 'genesisDataHash', 'blockOneHash']) policy[key] = identity(policy[key], 'invalid_policy');
  if (policy.genesisHash !== expected.chainIdentity) fail('invalid_policy', 'The reviewed genesis hash must be the pinned chain identity');
  return Object.freeze(policy);
}

/**
 * No default pin exists. A pin names at most one genesis representation:
 *
 * `fallback` must be exactly
 * { blockZeroUnavailable: 'literal-error', documentation: '<reviewed reference>' }.
 * SDK source documents this specific first-queryable-block-one convention.
 * A timeout, null, malformed block or non-200 result never enables fallback.
 * The fallback reads numeric 0, string "0" and numeric 1, and requires the
 * string-zero genesis hash, confirmed block one's `previousHash` and the pin to
 * agree. A refused, malformed or unavailable string-zero answer refuses the
 * observation; it is never read as the literal-error marker.
 *
 * `stabilisedGenesis` must be exactly { representation: 'stabilised-genesis',
 * documentation, chainId (text or null), genesisHash (the pinned chain identity),
 * genesisDataHash, blockOneHash }. The reader must also have
 * `getChainIdentity(policy)`. Every bind reads numeric 0 (a confirmed block, never
 * the literal error), the chain identity and numeric 1. The three reads must agree
 * with each other (`conflicting_identity`) and with every reviewed value
 * (`identity_mismatch`); nothing is admitted from the node's own claims.
 * A block's `id`, when present, must equal its number, so a node that answers
 * with its database row id (the number plus one) is refused with `wrong_block`.
 * A reader that returns the literal `'error'` for block zero is refused with
 * `genesis_representation_mismatch`. The SDK's own readers return the node's
 * `{result: 400, response: 'error'}` envelope as it is under this pin, which has
 * no fallback, so through them that answer is refused as `unavailable`.
 *
 * A pin with both options is invalid. A saved binding of the other representation
 * is refused with binding_mismatch.
 * Returns a read-only binder whose observations grant no signing authority.
 * Each observation keeps its own state, so overlapping calls are independent;
 * only `exclusive: true` (the transport's own fenced binders) makes an
 * overlapping call reject with binding_busy.
 * Throws NetworkBindingError for an invalid policy; the binder's methods reject
 * with NetworkBindingError and keep a failed reader's error as `cause`.
 */
export function createDemosNetworkBinder({ expected: input, reader, fallback = null, stabilisedGenesis = null, now = () => Date.now(), maxAgeMs = 10_000, timeoutMs = 10_000, exclusive = false } = {}) {
  const expected = record(input, 'unpinned_network');
  exactKeys(expected, EXPECTED_KEYS, 'unpinned_network');
  if (!exactMatch(NETWORK, expected.network)) fail('unpinned_network', 'An exact reviewed network label is required');
  expected.chainIdentity = identity(expected.chainIdentity, 'unpinned_network');
  identifier(expected.pinVersion, 'unpinned_network');
  endpoint(expected.endpoint, 'unpinned_network');
  identifier(expected.transportAuthority, 'unpinned_network');
  Object.freeze(expected);
  if (!reader || typeof reader.getContext !== 'function' || typeof reader.getBlockByNumber !== 'function'
    || typeof now !== 'function') fail('invalid_reader', 'An injectable read-only transport and clock are required');
  if (stabilisedGenesis !== null && typeof reader.getChainIdentity !== 'function') fail('invalid_reader', 'A stabilised genesis requires a reader with a chain-identity read');
  if (stabilisedGenesis !== null && fallback !== null) fail('invalid_policy', 'A pin names one genesis representation, not the literal-error fallback and a stabilised genesis');
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 60_000) fail('invalid_policy', 'Read freshness must be between 1 and 60000 milliseconds');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) fail('invalid_policy', 'Observation timeout must be between 1 and 60000 milliseconds');
  let fallbackPolicy = null;
  if (fallback !== null) {
    fallbackPolicy = record(fallback, 'invalid_policy');
    exactKeys(fallbackPolicy, ['blockZeroUnavailable', 'documentation'], 'invalid_policy');
    if (fallbackPolicy.blockZeroUnavailable !== 'literal-error' || typeof fallbackPolicy.documentation !== 'string'
      || !fallbackPolicy.documentation.trim() || fallbackPolicy.documentation.length > 512) {
      fail('invalid_policy', 'The block-one fallback requires a documented literal-error policy');
    }
    Object.freeze(fallbackPolicy);
  }
  const stabilised = stabilisedGenesis === null ? null : stabilisedGenesisPolicy(stabilisedGenesis, expected);
  const id = bindingId(expected);
  let busy = false;
  const clock = () => timestamp(now(), 'invalid_clock');
  const fresh = (observedAt, at) => {
    timestamp(observedAt, 'stale_observation');
    if (observedAt > at || at - observedAt > maxAgeMs) fail('stale_observation', 'The read is stale or from the future');
  };

  // One monotonic deadline covers the context reads and every block read.
  // A timed-out injected operation is read-only and cannot yield a later fence.
  async function bounded(callback, deadline) {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining < 1) fail('unavailable', 'The identity observation deadline expired');
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(callback),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new NetworkBindingError('unavailable', 'The identity observation deadline expired')), remaining);
        }),
      ]);
      if (performance.now() > deadline) fail('unavailable', 'The identity observation deadline expired');
      return result;
    } finally { clearTimeout(timer); }
  }

  async function context(deadline) {
    let actual;
    try { actual = await bounded(() => reader.getContext(), deadline); } catch (error) { fail('unavailable', 'Transport context is unavailable', error); }
    const value = contextOf(actual);
    if (value.network !== expected.network || value.endpoint !== expected.endpoint
      || value.transportAuthority !== expected.transportAuthority) fail('transport_mismatch', 'The active transport differs from the reviewed network, endpoint or authority');
    return value;
  }

  // One reader call under the same context, receipt and freshness checks, for a block or for the chain identity.
  async function receiptOf(request, connection, deadline) {
    const before = await context(deadline);
    if (!sameContext(before, connection)) fail('connection_changed', 'The transport reconnected during identity observation');
    const requestedAt = clock();
    let receipt;
    try {
      receipt = await bounded(() => request(Object.freeze({ cache: 'no-store', redirect: 'error' })), deadline);
    } catch (error) { fail('unavailable', 'The identity read is unavailable', error); }
    const read = record(receipt);
    exactKeys(read, ['value', 'context', 'observedAt', 'fromCache', 'redirected'], 'malformed_observation');
    if (read.fromCache !== false) fail('cached_observation', 'Cached or unspecified-cache identity reads are rejected');
    if (read.redirected !== false) fail('redirected_observation', 'Redirected or unspecified-route identity reads are rejected');
    const readContext = contextOf(read.context);
    if (!sameContext(readContext, connection)) fail('transport_mismatch', 'The read receipt differs from the active transport');
    fresh(read.observedAt, clock());
    if (read.observedAt < requestedAt) fail('stale_observation', 'The identity read predates this request');
    const after = await context(deadline);
    if (!sameContext(after, connection)) fail('connection_changed', 'The transport changed during identity observation');
    return read;
  }

  async function read(height, connection, deadline) {
    const { value, observedAt } = await receiptOf(policy => reader.getBlockByNumber(height, policy), connection, deadline);
    return { value: height === '0' ? genesisProjection(value) : sdkValue(value), observedAt };
  }

  async function readChainIdentity(connection, deadline) {
    const { value, observedAt } = await receiptOf(policy => reader.getChainIdentity(policy), connection, deadline);
    return { value: chainIdentityAnswer(value), observedAt };
  }

  // A saved source is valid only for the genesis representation the pin names.
  function sourceMatchesPolicy(source, hash) {
    if (stabilised) {
      return source.kind === 'stabilised-genesis' && source.blockNumber === 0 && hash === expected.chainIdentity
        && source.fallbackDocumentation === stabilised.documentation;
    }
    return (source.kind === 'block-zero-hash' && source.blockNumber === 0 && hash === expected.chainIdentity && source.fallbackDocumentation === null)
      || (source.kind === 'confirmed-block-one-predecessor' && source.blockNumber === 1 && fallbackPolicy !== null
        && source.fallbackDocumentation === fallbackPolicy.documentation);
  }

  function persisted(value, { allowExpired = false } = {}) {
    const saved = record(value, 'binding_mismatch');
    exactKeys(saved, RECORD_KEYS, 'binding_mismatch');
    if (saved.bindingVersion !== DEMOS_NETWORK_BINDING_VERSION || saved.bindingId !== id
      || EXPECTED_KEYS.some((key) => saved[key] !== expected[key])) fail('binding_mismatch', 'The saved binding version or reviewed identity differs');
    identifier(saved.connectionId, 'binding_mismatch');
    const source = record(saved.source, 'binding_mismatch');
    exactKeys(source, ['kind', 'blockNumber', 'blockHash', 'fallbackDocumentation'], 'binding_mismatch');
    const hash = identity(source.blockHash, 'binding_mismatch');
    if (!sourceMatchesPolicy(source, hash)) fail('binding_mismatch', 'The saved binding source differs from the configured read policy');
    timestamp(saved.observedAt, 'binding_mismatch');
    timestamp(saved.expiresAt, 'binding_mismatch');
    if (saved.expiresAt !== saved.observedAt + maxAgeMs || saved.observedAt > clock()) fail('binding_mismatch', 'The saved binding timestamps are invalid');
    if (!allowExpired) fresh(saved.observedAt, clock());
    return saved;
  }

  // Numeric block zero, or under the literal-error fallback the string-zero genesis and confirmed block one.
  async function observeLiteralPolicy(connection, deadline) {
    const zero = await read(0, connection, deadline);
    if (zero.value !== 'error') {
      exactHeight(zero.value, 0);
      const blockZeroHash = identity(zero.value.hash);
      exactAliases(zero.value, blockZeroHash);
      return { observedIdentity: blockZeroHash, observedAt: zero.observedAt, source: { kind: 'block-zero-hash', blockNumber: 0, blockHash: blockZeroHash, fallbackDocumentation: null } };
    }
    if (!fallbackPolicy) fail('unavailable', 'Block zero is unavailable and no reviewed block-one fallback is configured');
    const genesis = await read('0', connection, deadline);
    const first = await read(1, connection, deadline);
    if (first.value === 'error') fail('unavailable', 'Block one is unavailable');
    const predecessor = blockOnePredecessor(first.value);
    if (genesis.value.hash !== predecessor) fail('conflicting_identity', "The genesis hash differs from block one's predecessor");
    fresh(zero.observedAt, clock());
    fresh(genesis.observedAt, clock());
    return { observedIdentity: predecessor, observedAt: first.observedAt,
      source: { kind: 'confirmed-block-one-predecessor', blockNumber: 1, blockHash: identity(first.value.hash), fallbackDocumentation: fallbackPolicy.documentation } };
  }

  // Numeric block zero, the chain identity and confirmed block one: they must agree with each other and with every reviewed value.
  async function observeStabilised(connection, deadline) {
    const zero = await read(0, connection, deadline);
    if (zero.value === 'error') fail('genesis_representation_mismatch', 'Block zero answers the literal error, so the node does not serve the stabilised genesis');
    exactHeight(zero.value, 0);
    const genesisHash = identity(zero.value.hash);
    exactAliases(zero.value, genesisHash);
    const named = await readChainIdentity(connection, deadline);
    const first = await read(1, connection, deadline);
    if (first.value === 'error') fail('unavailable', 'Block one is unavailable');
    const predecessor = blockOnePredecessor(first.value);
    if (named.value.genesisHash !== genesisHash || predecessor !== genesisHash) fail('conflicting_identity', "Block zero, the chain identity and block one's predecessor disagree");
    const observed = [genesisHash, named.value.chainId, named.value.genesisDataHash, identity(first.value.hash)];
    const reviewed = [stabilised.genesisHash, stabilised.chainId, stabilised.genesisDataHash, stabilised.blockOneHash];
    if (observed.some((value, index) => value !== reviewed[index])) fail('identity_mismatch', 'An observed value differs from the reviewed stabilised genesis');
    return { observedIdentity: genesisHash, observedAt: Math.min(zero.observedAt, named.observedAt, first.observedAt),
      source: { kind: 'stabilised-genesis', blockNumber: 0, blockHash: genesisHash, fallbackDocumentation: stabilised.documentation } };
  }

  async function observe(saved = undefined, recovery = false) {
    if (exclusive) {
      if (busy) fail('binding_busy', 'A network identity observation is already in progress');
      busy = true;
    }
    try {
      const deadline = performance.now() + timeoutMs;
      if (saved !== undefined) persisted(saved, { allowExpired: recovery });
      const connection = await context(deadline);
      const { observedIdentity, observedAt, source } = await (stabilised ? observeStabilised : observeLiteralPolicy)(connection, deadline);
      if (observedIdentity !== expected.chainIdentity) fail('identity_mismatch', 'The observed chain differs from the independently reviewed pin');
      if (!sameContext(await context(deadline), connection)) fail('connection_changed', 'The transport changed before the binding fence');
      fresh(observedAt, clock());
      const expiresAt = timestamp(observedAt + maxAgeMs, 'invalid_clock');
      return Object.freeze({
        bindingVersion: DEMOS_NETWORK_BINDING_VERSION, bindingId: id, ...expected,
        connectionId: connection.connectionId, source: Object.freeze(source), observedAt, expiresAt,
      });
    } finally { if (exclusive) busy = false; }
  }

  return Object.freeze({
    bind: () => observe(),
    recheck: (saved) => saved === undefined ? fail('binding_mismatch', 'Recheck requires a saved binding') : observe(saved),
    recover: (saved) => saved === undefined ? fail('binding_mismatch', 'Recovery requires a saved binding') : observe(saved, true),
    beforeSignature: (saved) => saved === undefined ? fail('binding_mismatch', 'The signature fence requires a saved binding') : observe(saved),
    beforeBroadcast: (saved) => saved === undefined ? fail('binding_mismatch', 'The broadcast fence requires a saved binding') : observe(saved),
  });
}
