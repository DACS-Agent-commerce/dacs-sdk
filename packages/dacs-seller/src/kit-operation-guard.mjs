// The kit's operation guard (K11): while it is off, nothing in this package
// signs, sends or rebroadcasts. It imports nothing and reads no environment
// variable, file, argument or option, so nothing a caller supplies can admit.

/** The kit's operation switch. Only the exact string 'testnet-tp1' admits; every other value, 'off' included, refuses. */
export const KIT_OPERATION_GUARD = 'off';

/** Thrown while the guard is off. `code` is 'kit_operation_guard_off' and `entry` names the refused entry. */
export class KitOperationGuardError extends Error {
  constructor(entry) {
    super(`the kit operation guard is off: ${entry} is refused until the testnet switch`);
    this.name = 'KitOperationGuardError';
    this.code = 'kit_operation_guard_off';
    this.entry = entry;
  }
}

/** True only when the switch is exactly 'testnet-tp1'. Synchronous; reads nothing else. */
export function kitOperationAdmitted() {
  return KIT_OPERATION_GUARD === 'testnet-tp1';
}

/** Returns when the guard admits; throws KitOperationGuardError naming `entry` while it is off. */
export function assertKitOperationAdmitted(entry) {
  if (!kitOperationAdmitted()) throw new KitOperationGuardError(entry);
}
