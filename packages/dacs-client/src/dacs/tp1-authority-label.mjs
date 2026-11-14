const TP1_AUTHORITY_LABEL = /^TP1-[0-9a-f]{32}$/;

/**
 * Returns true only for the canonical serialized TP-1 authority label: `TP1-` plus 32 lower-case hex digits.
 * It never throws. A label names an authority and grants none: only a token from `admitTp1Authority` does.
 */
export function isTp1AuthorityLabel(value) {
  return typeof value === 'string' && TP1_AUTHORITY_LABEL.test(value);
}
