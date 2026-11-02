// Unit tests isolate settlement validation from the factory authority. The real
// authority is exercised by settlementFailure and payDemExecutedStatus tests.
export function createPayDemExecutionAuthority() {
  return {
    register<T extends object>(value: T): T { return value; },
    assertCapability(): void {},
    attest<T extends object>(value: T): T { return value; },
    hasVerdict(): boolean { return true; },
  };
}
