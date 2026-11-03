// Pure logical and transaction references; no fixture store or receipt authority.
export const artifactRef = (logicalAddress, hash) => ({ anchor: {kind:'storage-program', locator:logicalAddress}, contentHash:hash });
export const artifactTxRef = receipt => ({kind:'storage-program', address:receipt.nativeAddress, writeTxHash:receipt.transactionRef.value});
