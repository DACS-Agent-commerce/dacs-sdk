// One exact account balance read over a node transport owner's own connection, for a read-only command such as the seller doctor.
import { OperationError } from '../client-errors.mjs';
import { balanceOsFromNode, isRecord } from '../dacs/chain.mjs';
import { normalizeDemosAddress } from '../signatures.mjs';
import { fetchBoundedJson, OutboundError } from '../util/http.mjs';

const ADDRESS_BALANCE_MAX_BYTES = 65_536;
const ADDRESS_BALANCE_TIMEOUT_MS = 10_000;
const refusal = (code, cause) => new OperationError(code, code, undefined, cause === undefined ? undefined : { cause });

// Maps a failed balance read to its refusal; a caller's abort keeps its own reason.
function readRefusal(error, signal) {
  if (signal?.aborted) return error;
  if (error instanceof OutboundError && error.kind === 'timeout') return refusal('seller_balance_timeout', error);
  return refusal(error instanceof OutboundError && error.kind === 'invalid' ? 'seller_balance_malformed' : 'seller_balance_unavailable', error);
}

/**
 * Resolves `{ address, balanceOs }` from one `getAddressInfo` read over `owner`'s own connection: the normalized `address` and its
 * exact balance as a canonical nonnegative decimal OS string. The reply is limited to 65,536 bytes before decoding and the read to
 * 10,000 ms. It signs nothing, takes no connection fence and opens no file. Rejects OperationError seller_balance_malformed (a
 * malformed address, with the WalletFormatError as cause, or a reply without one exact balance), seller_balance_unavailable,
 * seller_balance_timeout or seller_balance_connection_changed (the owner's connection changed during the read), each with its
 * cause; transport_closed for a closed owner; and the caller's abort reason.
 */
export async function readNodeAddressBalance({ owner, address, signal }) {
  let normalized;
  try { normalized = normalizeDemosAddress(address); } catch (error) { throw refusal('seller_balance_malformed', error); }
  const { endpoint, connectionId } = owner.currentLocal();
  const body = { method: 'nodeCall', params: [{ message: 'getAddressInfo', data: { address: normalized } }] };
  const reply = await fetchBoundedJson(endpoint, { method: 'POST', body, fetchImpl: (...args) => owner.fetchImpl(...args), timeoutMs: ADDRESS_BALANCE_TIMEOUT_MS,
    maxBytes: ADDRESS_BALANCE_MAX_BYTES, expectedOrigin: new URL(endpoint).origin, signal }).catch((error) => { throw readRefusal(error, signal); });
  if (owner.currentLocal().connectionId !== connectionId) throw refusal('seller_balance_connection_changed');
  if (!isRecord(reply)) throw refusal('seller_balance_malformed');
  if (reply.result !== 200) throw refusal('seller_balance_unavailable');
  const balance = isRecord(reply.response) ? balanceOsFromNode(reply.response.balance, 'os-string') : null;
  if (balance === null) throw refusal('seller_balance_malformed');
  return { address: normalized, balanceOs: balance.toString() };
}
