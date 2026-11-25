// The authority a kit capability constructor accepts: a fixture `TEST-` label, or a TP-1 token admitted for the composition's
// own binding. The rule is the client's; this module only adds the kit's fixture pattern and the constructor's own refusal.
import { isDemDeliveryContextAuthority } from '@kynesyslabs/dacs-client';
import { capabilityAuthorityLabel, isTp1AuthorityToken } from '@kynesyslabs/dacs-client/node-wallet';

const isFixtureLabel = (value) => typeof value === 'string' && /^TEST-[A-Za-z0-9._:-]{1,115}$/.test(value);

/**
 * Returns the label string a constructor stores for `authority`: a `TEST-` label unchanged, or the label of a token admitted
 * for `binding`. A constructor runs its own kit guard for a token before it calls this. Throws `refuse()`'s error for a value
 * that is neither a canonical label string nor a token, OperationError(authority_unbound) for a `TP1-` label string or a token
 * of another or missing binding, and OperationError(profile_not_admitted) while the client's purchase actions are held.
 */
export function admitKitCapabilityAuthority(authority, { binding, refuse }) {
  if (!isTp1AuthorityToken(authority) && !isDemDeliveryContextAuthority(authority)) refuse();
  return capabilityAuthorityLabel(authority, binding, isFixtureLabel, 'a capability authority is a TEST- label or a bound TP-1 token');
}
