/**
 * A recording approval ledger for the payment-evidence adapter: `prepare` opens one authorization per request,
 * `open` finds the open one by its exact text, `settle` records outcomes by id and is idempotent for the same outcome.
 * `script` holds one-shot behaviours for the next prepare calls: 'refuse' (resolves null), 'throw' (fails before
 * committing), 'commit-then-throw' (commits, then fails), 'mutate' (changes the request object it received),
 * 'other-text' (answers other text), or a function (request, entry) run after the commit. `lookupDown` makes `open`
 * fail. `reopen` and `confirm` are not used by signing and refuse.
 */
export function recordingApproval() {
  const entries = [], prepared = [], script = [], settled = new Map(), settlements = [];
  const double = { entries, prepared, script, settled, settlements, lookupDown: false,
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
    reopen: async () => { throw new Error('TEST-reopen-is-not-used-by-signing'); },
    confirm: async () => { throw new Error('TEST-confirm-is-not-used-by-signing'); },
    async settle(ledgerId, outcome, reason) {
      if (settled.has(ledgerId) && settled.get(ledgerId) !== outcome) throw new Error(`TEST-${ledgerId}-already-${settled.get(ledgerId)}`);
      settled.set(ledgerId, outcome);
      settlements.push({ ledgerId, outcome, reason });
    },
  };
  return double;
}
