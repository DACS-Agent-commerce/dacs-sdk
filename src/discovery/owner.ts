/**
 * Canonical comparison form for a Demos owner key. Demos surfaces are
 * inconsistent about the cosmetic `0x` prefix, but stripping it from an
 * arbitrary non-key identifier would change that identifier's meaning.
 */
export function normalizedBindingOwner(owner: string): string {
  const normalized = owner.trim().toLowerCase();
  const match = normalized.match(/^(?:0x)?([0-9a-f]{64})$/);
  return match?.[1] ?? normalized;
}
