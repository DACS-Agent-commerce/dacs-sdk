import { OperationError } from '../client-errors.mjs';
import { isTp1AuthorityLabel } from './tp1-authority-label.mjs';

// Every token `admitTp1Authority` has made: the binding it was admitted for and the check that purchase actions are admitted.
const admissions = new WeakMap();

/** Records that `token` was admitted for `binding`, and that `assertAdmitted()` throws while purchase actions are held. Only the session's `admitTp1Authority` calls it. */
export function registerTp1Token(token, { binding, assertAdmitted }) {
  admissions.set(token, { binding, assertAdmitted });
}

/** Returns true only for a token made by `admitTp1Authority`; a label string, a copy or any other value is false. Never throws. */
export const isTp1AuthorityToken = value => admissions.has(value);

/**
 * Returns the label string a capability constructor stores for `authority`.
 * A fixture label (`isFixtureLabel(authority)`) is returned as it is. A token is accepted only while purchase actions are admitted,
 * and only for the very binding object it was admitted for (never by comparing labels, which two connections can share);
 * its label is returned. Throws OperationError(authority_unbound) for a `TP1-` label string, which names an authority and grants
 * none, and for a token of another binding; the held refusal OperationError(profile_not_admitted) while held; TypeError(`requirement`) for any other value.
 */
export function authorityLabel(authority, binding, isFixtureLabel, requirement) {
  if (isFixtureLabel(authority)) return authority;
  if (isTp1AuthorityLabel(authority)) throw new OperationError('authority_unbound', 'a TP1- label string is not an authority token');
  const admission = admissions.get(authority);
  if (admission === undefined) throw new TypeError(requirement);
  admission.assertAdmitted();
  if (admission.binding !== binding) throw new OperationError('authority_unbound', 'the authority token was admitted for another binding');
  return authority.label;
}
