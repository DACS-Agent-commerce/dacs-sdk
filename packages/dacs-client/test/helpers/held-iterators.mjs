// On Node 22.13.0 and 23.4.0 a collection can finalize a statement that only its
// iterator still uses, which fails or crashes the iterator's next step. A fixture
// whose iterators outlive the code that prepared their statements starts them
// here, so each statement stays reachable until the fixture releases it.

/** Start iterators for a fixture and keep their statements alive; returns `{ iterate, release }`. */
export function holdIterators() {
  const held = [];
  return {
    /** Starts `statement.iterate()`, keeps the statement reachable until `release()`, and returns the iterator. */
    iterate(statement) {
      const iterator = statement.iterate();
      held.push({ statement, iterator });
      return iterator;
    },
    /** Finishes every held iterator once, then lets go of its statement. */
    release() {
      for (const { iterator } of held.splice(0)) iterator.return();
    },
  };
}
