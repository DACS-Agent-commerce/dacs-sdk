/**
 * A recording approval ledger for the payment-evidence adapter: `prepare` opens one authorization per request,
 * `open` finds the open one by its exact text, `reopen` returns the open one by id and rejects
 * `approval_reservation_unavailable` for an unknown or settled id, `confirm` records each call and answers
 * `confirmResult` (a value, an Error to throw, or a function of the binding and the validity), and `settle` records
 * outcomes and is idempotent for the same outcome. Like the seller ledger, `settle` takes the binding `{ledgerId, requestText}`
 * and rejects a bare id (`invalid_params`) or a binding whose text is not its authorization's (`approval_reservation_unavailable`);
 * `bindingOf(ledgerId)` builds the binding of an entry.
 * `script` holds one-shot behaviours for the next prepare calls: 'refuse' (resolves null), 'throw' (fails before
 * committing), 'commit-then-throw' (commits, then fails), 'mutate' (changes the request object it received),
 * 'other-text' (answers other text), or a function (request, entry) run after the commit. `lookupDown` makes `open`
 * fail.
 * With `manual: true` it stands for the operator alone, as the seller ledger's manual mode does: `prepare` of a text whose
 * grant is open answers that grant again (same token) and asks nothing; otherwise it counts one operator decision in
 * `decisions`, runs the next `script` behaviour, lists the grant `{requestText, token, outcome}` in `grants` and answers
 * `{ledgerId: null, requestText, token}`. `open` answers the text's open grant; `settle` takes a manual binding by its token.
 * `withdraw(requestText)` is the operator ending the text's open grant. In both modes `revocationGeneration()` counts the
 * releases started (`withdraw` and every `settle` of `released`, as its first step); `settleFailures` makes the next that
 * many `settle` calls throw before they record anything; `closeUncounted(binding)` ends an authorization the way a release
 * written by another process would, with no `settle` call and no count.
 */
export function recordingApproval({ manual = false } = {}) {
  const entries = [], prepared = [], script = [], settled = new Map(), settlements = [], reopened = [], confirmations = [], grants = [];
  let revocations = 0;
  const openGrant = requestText => grants.find(grant => grant.requestText === requestText && grant.outcome === null);
  const unavailable = message => Object.assign(new Error(message), { code: 'approval_reservation_unavailable' });
  const double = { entries, prepared, script, settled, settlements, reopened, confirmations, grants, decisions: 0, settleFailures: 0, lookupDown: false, confirmResult: true,
    async prepare(request) {
      prepared.push(structuredClone(request));
      const requestText = JSON.stringify(request);
      if (manual && openGrant(requestText)) return { ledgerId: null, requestText, token: openGrant(requestText).token };
      if (manual) double.decisions += 1;
      const behaviour = script.shift();
      if (behaviour === 'refuse') return null;
      if (behaviour === 'throw') throw new Error('TEST-approval-failed');
      const entry = manual ? { requestText, token: Object.freeze({}), outcome: null } : { ledgerId: `TEST-ledger-${entries.length + 1}`, requestText };
      (manual ? grants : entries).push(entry);
      if (behaviour === 'commit-then-throw') throw new Error('TEST-approval-committed-then-lost');
      if (behaviour === 'mutate') request.content.nonce += 1;
      if (typeof behaviour === 'function') await behaviour(request, entry);
      const answered = behaviour === 'other-text' ? `${requestText} ` : requestText;
      return manual ? { ledgerId: null, requestText: answered, token: entry.token } : { ledgerId: entry.ledgerId, requestText: answered };
    },
    async open(requestText) {
      if (double.lookupDown) throw new Error('TEST-approval-lookup-down');
      const grant = openGrant(requestText);
      if (grant) return { ledgerId: null, requestText, token: grant.token };
      const entry = entries.find(row => row.requestText === requestText && !settled.has(row.ledgerId));
      return entry ? { ...entry } : null;
    },
    async reopen(ledgerId) {
      reopened.push(ledgerId);
      const entry = entries.find(row => row.ledgerId === ledgerId);
      if (!entry || settled.has(ledgerId)) throw unavailable('TEST-no-open-authorization');
      return { ...entry };
    },
    async confirm(binding, validity) {
      confirmations.push({ binding, validity });
      const result = double.confirmResult;
      if (result instanceof Error) throw result;
      return typeof result === 'function' ? result(binding, validity) : result;
    },
    bindingOf(ledgerId) {
      const entry = entries.find(row => row.ledgerId === ledgerId);
      if (!entry) throw new Error(`TEST-no-entry-${ledgerId}`);
      return { ledgerId, requestText: entry.requestText };
    },
    async settle(binding, outcome, reason) {
      if (outcome === 'released') revocations += 1;
      if (double.settleFailures > 0) { double.settleFailures -= 1; throw new Error('TEST-settlement-failed'); }
      if (binding?.ledgerId === null && typeof binding.requestText === 'string') return settleGrant(binding, outcome, reason);
      if (typeof binding?.ledgerId !== 'string' || typeof binding.requestText !== 'string') throw Object.assign(new Error('TEST-a retained binding is {ledgerId, requestText}'), { code: 'invalid_params' });
      const { ledgerId, requestText } = binding;
      if (entries.find(row => row.ledgerId === ledgerId)?.requestText !== requestText) throw unavailable('TEST-no-authorization-for-binding');
      if (settled.has(ledgerId) && settled.get(ledgerId) !== outcome) throw new Error(`TEST-${ledgerId}-already-${settled.get(ledgerId)}`);
      settled.set(ledgerId, outcome);
      settlements.push({ ledgerId, outcome, reason });
    },
    revocationGeneration: () => revocations,
    withdraw(requestText) {
      revocations += 1;
      openGrant(requestText).outcome = 'released';
    },
    closeUncounted(binding) {
      if (binding.ledgerId === null) grants.find(grant => grant.token === binding.token).outcome = 'released';
      else settled.set(binding.ledgerId, 'released');
    },
  };
  // A manual binding names its grant only by its token, for exactly that grant's text; a repeat of the same outcome changes nothing.
  function settleGrant({ requestText, token }, outcome, reason) {
    const grant = grants.find(row => row.token === token);
    if (grant?.requestText !== requestText) throw unavailable('TEST-no-grant-for-token');
    if (grant.outcome !== null && grant.outcome !== outcome) throw new Error(`TEST-grant-already-${grant.outcome}`);
    if (outcome !== 'unknown') grant.outcome = outcome;
    settlements.push({ ledgerId: null, token, outcome, reason });
  }
  return double;
}
