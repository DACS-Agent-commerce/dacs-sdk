// The read-only observer of a node transport owner's connection, and the deadline every authority or node read runs under.
import { TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { OperationError } from '../client-errors.mjs';
import { AUTHORITY_READ_DEADLINE_MS } from '../public-admission.mjs';
import { observeWithDeadline, OutboundError } from '../util/http.mjs';
import { createSourceObserver } from './devnet-native-transport.mjs';

const NODE_INFO_MESSAGES = Object.freeze(['getNetworkInfo', 'getNetworkParameters']);
const OBSERVER_PROVENANCE_PREFIX = `dacs-node-observer:${TP1_APPROVED_IDENTITY_RECORD.recordId}`;
const refuse = code => { throw new OperationError(code, code); };

/**
 * Resolves `read({signal})` within the 10 s authority read deadline. Rejects tp1_authority_timeout with the timer's error as cause,
 * the caller's abort reason, or the read's own error.
 */
export async function withinAuthorityDeadline(read, signal) {
  try { return await observeWithDeadline(read, { timeoutMs: AUTHORITY_READ_DEADLINE_MS, signal }); }
  catch (error) {
    if (error instanceof OutboundError && error.kind === 'timeout') throw new OperationError('tp1_authority_timeout', 'the authority read did not answer within the deadline', undefined, { cause: error });
    throw error;
  }
}

/**
 * Returns the fence-free, read-only observer for a node owner: {observe({signal}),
 * readNodeInfo(message, {signal}), provenance()}. Its expected identity and block-one fallback
 * come only from TP1_APPROVED_IDENTITY_RECORD. It acquires no connection fence, takes no
 * journal lock and signs nothing, so it works while a fence is held and before any journal or
 * custody is opened. observe resolves {local, chainIdentity, provenance} for the owner's current
 * connection once the node's chain matches the record; readNodeInfo resolves the node's answer
 * to getNetworkInfo or getNetworkParameters and refuses every other message (readonly_only).
 * Every node reply is limited to 4 MiB before decoding and each call to one 10 s deadline
 * (tp1_authority_timeout, cause kept); a caller's abort rejects with its own reason and starts
 * no further read. A reader failure keeps its original error. provenance() names the connection
 * generation (the owner's connectionId) and throws transport_closed after close.
 * Throws TypeError for an owner without currentLocal, getContext and fetchImpl.
 */
export function createNodeObserver({ owner, clock = { now: () => Date.now() } } = {}) {
  const source = createSourceObserver({ record: TP1_APPROVED_IDENTITY_RECORD, owner, now: () => clock.now(), timeoutMs: AUTHORITY_READ_DEADLINE_MS });
  const provenanceOf = connectionId => `${OBSERVER_PROVENANCE_PREFIX}:${connectionId}`;
  return Object.freeze({
    provenance: () => provenanceOf(owner.currentLocal().connectionId),
    observe: ({ signal } = {}) => withinAuthorityDeadline(async ({ signal: stop }) => {
      const { endpoint, transportAuthority, connectionId, chainIdentity } = await source.bind({ signal: stop });
      return { local: { endpoint, transportAuthority, connectionId }, chainIdentity, provenance: provenanceOf(connectionId) };
    }, signal),
    async readNodeInfo(message, { signal } = {}) {
      if (!NODE_INFO_MESSAGES.includes(message)) refuse('readonly_only');
      const answer = await withinAuthorityDeadline(({ signal: stop }) => source.post({ method: 'nodeCall', params: [{ message, data: {} }] }, {}, { signal: stop }), signal);
      if (answer?.result !== 200) refuse('upstream_unavailable');
      return answer.response;
    },
  });
}
