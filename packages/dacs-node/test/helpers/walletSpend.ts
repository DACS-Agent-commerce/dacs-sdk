import {
  createInMemoryWalletSpendStateStore,
  createWalletSpendAuthorityV1,
  type WalletSpendAuthorityV1,
  type WalletSpendPolicyV1,
  type WalletSpendRecoveryObservationV1,
  type WalletSpendReservationV1,
  type WalletSpendStatusV1,
} from "@kynesyslabs/dacs";

const TEST_POLICY: Readonly<WalletSpendPolicyV1> = Object.freeze({
  policyVersion: "1",
  policyId: "test-only-permissive-wallet-authority",
  wallet: "test-wallet",
  chainId: "test-chain",
  maximumConcurrentEffects: 1,
  maximumRetainedReservations: 1,
  assets: Object.freeze([]),
});

/**
 * Test seam for payment-track tests whose subject is the outer coordinator,
 * not wallet policy arithmetic. Dedicated wallet-authority tests use the real
 * implementation and durable stores.
 */
export function createPermissiveTestWalletSpendAuthorityV1(): WalletSpendAuthorityV1 {
  return Object.freeze({
    policy: TEST_POLICY,
    policyHash: "f".repeat(64),
    async reserve(reservation: Readonly<WalletSpendReservationV1>) {
      return Object.freeze({
        status: "reserved" as const,
        permit: Object.freeze({
          reservation: structuredClone(reservation),
          reservationId: reservation.reservationId,
          bindingHash: "e".repeat(64),
          settlementBindingHash: reservation.settlementBindingHash,
          owner: "test-wallet-authority",
          generation: 1,
          async assertCurrent() {},
          async beginEffect() {},
          async settle() {},
        }),
      });
    },
    async reconcile(
      _reservation: Readonly<WalletSpendReservationV1>,
      observation: Readonly<WalletSpendRecoveryObservationV1>,
    ) {
      return observation.disposition === "settled" ? "settled" : "released";
    },
    async inspect(): Promise<Readonly<WalletSpendStatusV1>> {
      return Object.freeze({
        policyId: TEST_POLICY.policyId,
        policyHash: "f".repeat(64),
        wallet: TEST_POLICY.wallet,
        chainId: TEST_POLICY.chainId,
        maximumConcurrentEffects: TEST_POLICY.maximumConcurrentEffects,
        activeEffects: 0,
        retainedReservations: 0,
        maximumRetainedReservations: TEST_POLICY.maximumRetainedReservations,
        operatorActionReservations: Object.freeze([]),
        assets: Object.freeze([]),
      });
    },
  });
}

/** Real in-memory authority for integration tests that must exercise accounting. */
export function createAccountingTestWalletSpendAuthorityV1(input: Readonly<{
  wallet: string;
  chainId: string;
  asset: string;
  balance?: string;
}>): WalletSpendAuthorityV1 {
  const ceiling = "999999999999999999999999999999";
  return createWalletSpendAuthorityV1({
    policyVersion: "1",
    policyId: "test-accounting-wallet-authority",
    wallet: input.wallet,
    chainId: input.chainId,
    maximumConcurrentEffects: 10,
    maximumRetainedReservations: 100,
    assets: [{
      asset: input.asset,
      maximumPerOrderDebit: ceiling,
      maximumNetworkFeeDebit: ceiling,
      minimumReserve: "0",
      rollingWindowMs: 86_400_000,
      maximumRollingEffects: 100,
      maximumRollingDebit: ceiling,
      maximumCumulativeDebit: ceiling,
      maximumCounterpartyDebit: ceiling,
    }],
  }, {
    store: createInMemoryWalletSpendStateStore(),
    readBalance: async () => input.balance ?? ceiling,
    authenticateRecovery: async () => true,
    owner: "test-accounting-authority",
    leaseDurationMs: 1_000,
  });
}
