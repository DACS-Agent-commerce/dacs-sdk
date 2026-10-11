export interface DacsWalletSpendRemoteOperationRetentionV1 {
  /** Durable rows retained for any one authenticated role. */
  maximumOperationsPerRole?: number;
  /** Durable rows retained across all authenticated roles. */
  maximumOperations?: number;
}

/** Finite compatibility default; operators can select a lower deployment limit. */
export const DACS_WALLET_SPEND_DEFAULT_MAXIMUM_OPERATIONS_PER_ROLE = 100_000;
/** Finite compatibility default with capacity reserved beyond any one role. */
export const DACS_WALLET_SPEND_DEFAULT_MAXIMUM_OPERATIONS = 1_000_000;

export function dacsWalletSpendRemoteOperationRetentionV1(
  input: Readonly<DacsWalletSpendRemoteOperationRetentionV1>,
): Readonly<{ maximumOperationsPerRole: number; maximumOperations: number }> {
  const maximumOperationsPerRole = input.maximumOperationsPerRole ??
    DACS_WALLET_SPEND_DEFAULT_MAXIMUM_OPERATIONS_PER_ROLE;
  const maximumOperations = input.maximumOperations ??
    DACS_WALLET_SPEND_DEFAULT_MAXIMUM_OPERATIONS;
  if (!Number.isSafeInteger(maximumOperationsPerRole) || maximumOperationsPerRole <= 0 ||
      !Number.isSafeInteger(maximumOperations) || maximumOperations <= 1 ||
      maximumOperationsPerRole >= maximumOperations) {
    throw new Error("wallet-spend-authority-operation-retention-invalid");
  }
  return Object.freeze({ maximumOperationsPerRole, maximumOperations });
}
