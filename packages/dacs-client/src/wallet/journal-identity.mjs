// The durable wallet journal handles this copy of the package opened. A reader that decides what was sent takes its
// history only from such a handle, so a stand-in cannot answer an empty history or a lock that holds nothing.
const registrations = new WeakMap();

/** registerDurableJournal(journal, {maxKeyBytes}) records a handle openDurableWalletJournal returned, with its key limit and its own lane and read methods. Returns undefined. */
export function registerDurableJournal(journal, { maxKeyBytes }) {
  registrations.set(journal, Object.freeze({ maxKeyBytes, entries: journal.entries, withOwnedOrAcquiredLane: journal.withOwnedOrAcquiredLane }));
}

/** registeredJournal(candidate) returns the frozen {maxKeyBytes, entries, withOwnedOrAcquiredLane} of a registered handle whose two methods are still its own, else undefined. It never throws. */
export function registeredJournal(candidate) {
  const registration = registrations.get(candidate);
  if (!registration || candidate.entries !== registration.entries || candidate.withOwnedOrAcquiredLane !== registration.withOwnedOrAcquiredLane) return undefined;
  return registration;
}
