// A kit capability constructor's authority: a fixture `TEST-` label, or a TP-1 token for the composition's own binding, by the client's rule.
import { isDemDeliveryContextAuthority } from '@kynesyslabs/dacs-client';
import { capabilityAuthorityLabel, isTp1AuthorityToken } from '@kynesyslabs/dacs-client/node-wallet';

const isFixtureLabel = (value) => typeof value === 'string' && /^TEST-[A-Za-z0-9._:-]{1,115}$/.test(value);

/**
 * Returns the label string a constructor stores: a `TEST-` label unchanged, or the label of a token admitted for `binding` (the
 * constructor runs its own kit guard for a token first). Throws `refuse()`'s error for a value that is neither a canonical label nor
 * a token, OperationError(authority_unbound) for a `TP1-` label string or a token of another or missing binding, and
 * OperationError(profile_not_admitted) while the client's purchase actions are held.
 */
export function admitKitCapabilityAuthority(authority, { binding, refuse }) {
  if (!isTp1AuthorityToken(authority) && !isDemDeliveryContextAuthority(authority)) refuse();
  return capabilityAuthorityLabel(authority, binding, isFixtureLabel, 'a capability authority is a TEST- label or a bound TP-1 token');
}
