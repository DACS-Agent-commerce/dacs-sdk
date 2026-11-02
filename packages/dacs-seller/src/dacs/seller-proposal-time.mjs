const GENERATED_AT_SKEW_MS = 10 * 60 * 1000;
// The proposal's generatedAt against the seller's clock (observedAt: when the
// seller first saw this proposal). admitted (seller context route): the
// seller durably admitted exactly this context request, whose admission found
// generatedAt fresh; the proposal is then accepted until the derived Agreement's
// deadline (generatedAt + deadlineSecAfterCommit). Otherwise the clock window applies.
export function proposalTimeProblem({ generatedAt, observedAt, admitted = false, deadlineSecAfterCommit }) {
  if (![generatedAt, observedAt].every(value => Number.isSafeInteger(value) && value >= 0) || typeof admitted !== 'boolean') return 'proposal timestamps must be nonnegative safe integers';
  if (admitted) {
    if (!Number.isSafeInteger(deadlineSecAfterCommit) || deadlineSecAfterCommit <= 0) return 'the admitted context deadline interval must be a positive safe integer';
    const deadline = generatedAt + deadlineSecAfterCommit * 1000;
    return Number.isSafeInteger(deadline) && observedAt < deadline ? null : 'proposal arrives after the admitted context request\'s Agreement deadline';
  }
  return Math.abs(generatedAt - observedAt) > GENERATED_AT_SKEW_MS ? 'proposal generatedAt is outside the seller clock window' : null;
}
