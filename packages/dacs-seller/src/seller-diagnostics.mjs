import { types as nodeTypes } from 'node:util';
import { isCanonicalJobId } from '@kynesyslabs/dacs';

const DIAGNOSTIC_CODES = new Set([
  'seller_diagnostic_unknown', 'runtime_unsupported', 'commitment_failed',
  'seller_key_unavailable', 'seller_key_location_invalid', 'seller_key_format_invalid',
  'seller_key_derivation_failed', 'seller_key_claim_mismatch', 'seller_key_role_refused', 'seller_key_closed',
  'party_vet_writer_failed', 'party_vet_store_failed',
  'seller_policy_ledger_unreadable', 'seller_policy_sign_authorization_failed',
  'conflict', 'binding-changed', 'indeterminate', 'invalid', 'buyer_access_closed',
  'not-pending', 'not-authorized', 'journal-capacity', 'journal-busy',
  'seller_vet_receipt_invalid', 'seller_presentation_indeterminate',
]);
const CONTEXT_VALUES = Object.freeze({
  role: ['buyer', 'seller'],
  operation: ['release', 'deletion'],
  category: ['transient', 'permanent', 'counterparty', 'substrate'],
  writerCause: ['conflict', 'binding-changed', 'denied', 'rejected', 'indeterminate', 'invalid', 'closed', 'not-pending', 'capacity', 'busy', 'failed'],
});

/**
 * Returns a bounded public diagnostic: an allowlisted code and validated
 * nonsecret context. Unknown codes become seller_diagnostic_unknown. Ignores
 * arbitrary error text, causes, key objects, accessors and proxies; never
 * coerces their values or retains a redactor. Does not throw for unknown input.
 */
export function sellerDiagnostic(code, context) {
  const diagnostic = { code: typeof code === 'string' && DIAGNOSTIC_CODES.has(code) ? code : 'seller_diagnostic_unknown' };
  if (context === null || typeof context !== 'object' || nodeTypes.isProxy(context)) return diagnostic;
  const valueOf = name => Object.getOwnPropertyDescriptor(context, name)?.value;
  const jobId = valueOf('jobId');
  if (typeof jobId === 'string' && isCanonicalJobId(jobId)) diagnostic.jobId = jobId;
  for (const [name, values] of Object.entries(CONTEXT_VALUES)) {
    const value = valueOf(name);
    if (typeof value === 'string' && values.includes(value)) diagnostic[name] = value;
  }
  const ledgerLine = valueOf('ledgerLine');
  if (Number.isSafeInteger(ledgerLine) && ledgerLine > 0) diagnostic.ledgerLine = ledgerLine;
  return diagnostic;
}
