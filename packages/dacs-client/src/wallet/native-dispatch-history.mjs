// Whether a retained native transaction can ever have reached the node, read from its whole dispatch history.
// Internal: not exported by the package.
const DISPATCH_RECORD = /^(recovery-)?dispatch-(started|withheld|acknowledged|unknown)$/;
const OTHER_RECORD = /^(signed|signed-held|(recovery-)?confirm-(started|withheld|acknowledged|unknown))$/;

/**
 * Classifies the records of one artifact, in commit order, as `{ status: 'never-transmitted' }`,
 * `{ status: 'earlier-possible', message }` or `{ status: 'unavailable', message }`.
 * `never-transmitted`: every `dispatch-started` has its own `dispatch-withheld`, and no dispatch was acknowledged or unknown,
 * no record says the artifact was observed and no recovery dispatch ran. `earlier-possible`: some record shows a possible
 * transmission, which no later withheld pass undoes. `unavailable`: a record this history does not define, or a withheld
 * record with no start of its own.
 */
export function classifyDispatchHistory(records) {
  const started = new Set(), withheld = new Set();
  let possible = false;
  for (const { state, passId } of records) {
    const [, recovery, phase] = DISPATCH_RECORD.exec(state) ?? [];
    if (recovery || state === 'observed' || phase === 'acknowledged' || phase === 'unknown') possible = true;
    else if (phase === 'started') started.add(passId);
    else if (phase === 'withheld') {
      if (!started.has(passId)) return { status: 'unavailable', message: `the ${state} record of pass ${passId} has no start` };
      withheld.add(passId);
    } else if (!OTHER_RECORD.test(state)) return { status: 'unavailable', message: `the history holds an unknown ${state} record` };
  }
  return possible || [...started].some((passId) => !withheld.has(passId))
    ? { status: 'earlier-possible', message: 'an earlier dispatch may have reached the node' }
    : { status: 'never-transmitted' };
}
