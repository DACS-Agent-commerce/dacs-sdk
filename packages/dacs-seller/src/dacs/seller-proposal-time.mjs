const GENERATED_AT_SKEW_MS = 10 * 60 * 1000;
// The proposal's generatedAt against the seller's clock (observedAt: when the
// seller first saw this proposal). admitted (seller context route): the
// seller durably admitted exactly this context request, whose admission found
// generatedAt fresh; the proposal is then accepted until the derived Agreement's
// deadline (generatedAt + deadlineSecAfterCommit). Otherwise the clock window applies.
export function proposalTimeProblem({ generatedAt, observedAt, admitted = false, deadlineSecAfterCommit }) {
  if (admitted) return Number.isSafeInteger(generatedAt) && observedAt < generatedAt + deadlineSecAfterCommit * 1000 ? null : 'proposal arrives after the admitted context request\'s Agreement deadline';
  return !Number.isSafeInteger(generatedAt) || Math.abs(generatedAt - observedAt) > GENERATED_AT_SKEW_MS ? 'proposal generatedAt is outside the seller clock window' : null;
}
