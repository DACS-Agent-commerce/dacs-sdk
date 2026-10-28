import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
// The wallet journal contract is the last section of the README.
const recovery = readme.slice(readme.indexOf('`readAccountNonce()`'));

// A transaction-absence answer that lets the seller supersede a nonce must be
// fenced. Anything that lets an ordinary miss or unknown answer ask for a new
// signature would let one evidence anchor be signed twice.
const UNSAFE_ORDINARY_MISS = /ordinary [^.]{0,80}miss[^.]{0,120}(new signature|sign again|re-?sign|new transaction)|unknown answer[^.]{0,120}(new signature|sign again|re-?sign|new transaction)/i;

test('wallet recovery requires a complete authenticated transaction index for a fenced absence', () => {
  assert.match(recovery, /from a complete authenticated\s+transaction index, including failed transactions, on the same chain/);
  assert.match(recovery, /`checkedThroughBlock` must be at least the nonce snapshot's `blockHeight`/);
  assert.match(recovery, /A bare nonce or an unfenced absence never authorizes supersession/);
});

test('wallet recovery states every readTransactionState answer and that inclusion alone is not execution', () => {
  assert.match(recovery, /`readTransactionState\(\{ txHash \}\)` answers\s+`'applied'`, `'pending'`, or `'absent'`/);
  assert.match(recovery, /Applied means successful execution;\s+inclusion alone does not establish execution/);
});

test('an ordinary miss keeps the original signed CREATE and never permits a new signature', () => {
  assert.match(recovery, /An ordinary miss or unknown\s+answer keeps the original signed CREATE alive for rebroadcast/);
  assert.doesNotMatch(recovery, UNSAFE_ORDINARY_MISS);
  // The negative check must reject a contradictory instruction even when the
  // safe phrases above are also present.
  assert.match(
    'An ordinary miss permits a new signature for the same evidence.',
    UNSAFE_ORDINARY_MISS,
    'the ordinary-miss check detects an unsafe new-signature instruction',
  );
});
