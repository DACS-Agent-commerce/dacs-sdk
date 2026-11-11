/**
 * A recording approval ledger for the payment-evidence adapter: `prepare` opens one authorization per request,
 * `open` finds the open one by its exact text, `reopen` returns the open one by id and rejects
 * `approval_reservation_unavailable` for an unknown or settled id, `confirm` records each call and answers
 * `confirmResult` (a value, an Error to throw, or a function of the binding and the validity), and `settle` records
 * outcomes by id and is idempotent for the same outcome.
 * `script` holds one-shot behaviours for the next prepare calls: 'refuse' (resolves null), 'throw' (fails before
 * committing), 'commit-then-throw' (commits, then fails), 'mutate' (changes the request object it received),
 * 'other-text' (answers other text), or a function (request, entry) run after the commit. `lookupDown` makes `open`
 * fail.
 */
export function recordingApproval() {
  const entries = [], prepared = [], script = [], settled = new Map(), settlements = [], reopened = [], confirmations = [];
  const double = { entries, prepared, script, settled, settlements, reopened, confirmations, lookupDown: false, confirmResult: true,
    async prepare(request) {
      prepared.push(structuredClone(request));
      const behaviour = script.shift();
      if (behaviour === 'refuse') return null;
      if (behaviour === 'throw') throw new Error('TEST-approval-failed');
      const requestText = JSON.stringify(request), entry = { ledgerId: `TEST-ledger-${entries.length + 1}`, requestText };
      entries.push(entry);
      if (behaviour === 'commit-then-throw') throw new Error('TEST-approval-committed-then-lost');
      if (behaviour === 'mutate') request.content.nonce += 1;
      if (typeof behaviour === 'function') await behaviour(request, entry);
      return { ledgerId: entry.ledgerId, requestText: behaviour === 'other-text' ? `${requestText} ` : requestText };
    },
    async open(requestText) {
      if (double.lookupDown) throw new Error('TEST-approval-lookup-down');
      const entry = entries.find(row => row.requestText === requestText && !settled.has(row.ledgerId));
      return entry ? { ...entry } : null;
    },
    async reopen(ledgerId) {
      reopened.push(ledgerId);
      const entry = entries.find(row => row.ledgerId === ledgerId);
      if (!entry || settled.has(ledgerId)) throw Object.assign(new Error('TEST-no-open-authorization'), { code: 'approval_reservation_unavailable' });
      return { ...entry };
    },
    async confirm(binding, validity) {
      confirmations.push({ binding, validity });
      const result = double.confirmResult;
      if (result instanceof Error) throw result;
      return typeof result === 'function' ? result(binding, validity) : result;
    },
    async settle(ledgerId, outcome, reason) {
      if (settled.has(ledgerId) && settled.get(ledgerId) !== outcome) throw new Error(`TEST-${ledgerId}-already-${settled.get(ledgerId)}`);
      settled.set(ledgerId, outcome);
      settlements.push({ ledgerId, outcome, reason });
    },
  };
  return double;
}
