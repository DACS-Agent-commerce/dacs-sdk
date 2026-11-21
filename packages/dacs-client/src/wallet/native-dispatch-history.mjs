// Whether a retained native transaction can ever have reached the node, read from its whole dispatch history.
// Internal: not exported by the package.

// The dispatch history records that never mean the bytes were sent: the signed bytes, every confirm record (the node
// only checks the bytes), and a dispatch pass refused before its send (`dispatch-started` paired with `dispatch-withheld`).
export const UNSENT_STATES = new Set(['signed', 'confirm-started', 'confirm-withheld', 'confirm-unknown', 'confirm-acknowledged', 'dispatch-started', 'dispatch-withheld']);
// Whether nothing in a signed artifact's history may have sent it: no unpaired or answered dispatch, and no recovery
// or held record. Only then may a new lease continue the operation that signed these bytes.
export const nothingSent = (records) => records.every((record) => UNSENT_STATES.has(record.state)
  && (record.state !== 'dispatch-started' || records.some((other) => other.state === 'dispatch-withheld' && other.passId === record.passId)));

/**
 * Classifies the records of one artifact, in commit order, as `{ status: 'never-transmitted' }`,
 * `{ status: 'earlier-possible', message }` or `{ status: 'unavailable', message }`.
 * `never-transmitted`: `nothingSent` holds and every `dispatch-withheld` comes after its own pass's `dispatch-started`.
 * `unavailable`: a `dispatch-withheld` record with no start of its own before it. `earlier-possible`: any other history,
 * which may have sent the bytes.
 */
export function classifyDispatchHistory(records) {
  const started = new Set();
  for (const { state, passId } of records) {
    if (state === 'dispatch-started') started.add(passId);
    else if (state === 'dispatch-withheld' && !started.has(passId)) return { status: 'unavailable', message: `the ${state} record of pass ${passId} has no start` };
  }
  return nothingSent(records) ? { status: 'never-transmitted' } : { status: 'earlier-possible', message: 'a record in the history may mean the bytes reached the node' };
}
