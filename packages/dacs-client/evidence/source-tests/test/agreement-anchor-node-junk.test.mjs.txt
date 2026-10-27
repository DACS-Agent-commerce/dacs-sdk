// the source change, the buyer's Agreement anchor through the wallet bridge: a node answer
// that does not authenticate at a readback before any adapter plan exists
// (the first anchor's planWrite, or recovery after the adapter's plan is lost)
// never ends the purchase at agreement_rejected. The adapter refuses it as an
// unmarked `invalid`, and the bridge answers it like any readback: only an
// authenticated contradiction or the wallet lane's own refusal rejects.
// Nothing is sent again: a fresh intent whose first read failed stays
// readback-only, and a broadcast CREATE is only read back.
// Review findings: PR the source change an earlier review, code P2-1 / a review P2-1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createsOf, junkFaults, sign, start } from './helpers/commitment-node-junk.mjs';

const FAKE = `stor-${'ab'.repeat(20)}`;
const envelope = (response) => ({ result: 200, response, require_reply: false, extra: null });

// The first name-index search for the Agreement's program lists FAKE; its
// native readback names another program, or another logical address under
// the buyer's own key. Every later read is clean.
function firstAnchorJunk(kind) {
  let h = null, query = null, served = 0;
  // The purchase's buyer wallet, from its prepared terms (by job).
  const buyerOf = (programName) => {
    const jobId = decodeURIComponent(programName).slice('dacs3:agreement:'.length);
    return h.app.db.prepare('SELECT terms FROM operations').all().map((row) => JSON.parse(row.terms)).find((terms) => terms?.protocol?.jobId === jobId)?.buyer?.wallet;
  };
  return {
    bind(harness) { h = harness; },
    served: () => served,
    hook: async (body, url) => {
      const call = body?.params?.[0];
      if (call?.message === 'searchStoragePrograms' && String(call.data?.query ?? '').startsWith('dacs3%3Aagreement%3A') && served === 0) {
        served = 1; query = call.data.query;
        return envelope([{ storageAddress: FAKE, programName: query }]);
      }
      if (url !== `/storage-program/${FAKE}`) return undefined;
      return kind === 'program-name'
        ? { success: true, storageAddress: FAKE, owner: `0x${'cd'.repeat(32)}`, programName: 'not-the-agreement', data: {}, metadata: {} }
        : { success: true, storageAddress: FAKE, owner: buyerOf(query), programName: query, data: {}, metadata: { logicalAddress: 'dacs3:agreement:another-job' } };
    },
  };
}

const outcomes = (op) => op.state.protocol.attempts.filter((x) => ['agreement', 'commitment', 'commit-request'].includes(x.step)).map((x) => `${x.step}/${x.outcome}${x.reason ? ` (${String(x.reason).slice(0, 120)})` : ''}`);

for (const commitOnSignature of [false, true]) {
  const mode = `DACS_COMMIT_ON_SIGNATURE=${commitOnSignature ? 'on' : 'off'}`;

  for (const kind of ['program-name', 'metadata-address']) {
    test(`${mode}: ${kind} junk at the first Agreement anchor's readback never ends the purchase; nothing is sent`, { timeout: 600000 }, async (t) => {
      const f = firstAnchorJunk(kind), h = await start(t, f, commitOnSignature), a = await sign(t, h);
      try { await a.approve(); } catch { /* no CREATE was queued for the wallet */ }
      await h.sellerTiming.waitForIdle({ timeoutMs: 60000 });
      for (let i = 0; i < 2; i++) { await a.verify(); await h.sellerTiming.waitForIdle({ timeoutMs: 60000 }); }
      const op = a.operation(), line = outcomes(op).join(' | ');
      assert.equal(f.served(), 1, line);
      assert.ok(op.state.protocol.attempts.some((x) => x.step === 'agreement' && x.outcome === 'indeterminate' && /: invalid$/.test(x.reason)), line);
      assert.equal(op.status, 'agreement_pending', line);
      assert.ok(!op.state.protocol.attempts.some((x) => x.outcome === 'rejected'), line);
      assert.equal(createsOf(h, 'Agreement').length, 0, 'nothing was sent');
    });
  }

  // The CREATE is broadcast once; its first readback finds no block, so the
  // purchase is still signing. The adapter's plan is then lost (its scope no
  // longer matches), and the bridge's recovery re-reads the record before any
  // plan exists. That read cannot authenticate the node's rendering without the
  // signed bytes, and a node answer that does not authenticate is unmarked.
  test(`${mode}: recovery after the adapter's plan is lost never ends the purchase; the one CREATE is only read back`, { timeout: 600000 }, async (t) => {
    const f = junkFaults('block-not-found', 'Agreement'), h = await start(t, f, commitOnSignature), a = await sign(t, h);
    f.arm(1);
    try { await a.approve(); } catch { /* the readback is not established */ }
    f.disarm();
    await h.sellerTiming.waitForIdle({ timeoutMs: 60000 });
    let op = a.operation();
    assert.equal(createsOf(h, 'Agreement').length, 1, outcomes(op).join(' | '));
    assert.equal(op.state.protocol.stage, 'agreement-signing', outcomes(op).join(' | '));
    const journal = h.transport.capability.journal;
    let lost = 0;
    for (const [key, value] of await journal.entries()) if (key.startsWith('sr2/adapter/')) { await journal.put(key, { ...value, scope: 'lost' }); lost += 1; }
    assert.ok(lost >= 1, 'the adapter retained a plan');
    for (let i = 0; i < 2; i++) { await a.verify(); await h.sellerTiming.waitForIdle({ timeoutMs: 60000 }); }
    op = a.operation();
    const line = outcomes(op).join(' | ');
    assert.ok(op.state.protocol.attempts.some((x) => x.step === 'agreement' && x.outcome === 'indeterminate' && /: invalid$/.test(x.reason)), line);
    assert.equal(op.status, 'agreement_pending', line);
    assert.ok(!op.state.protocol.attempts.some((x) => x.outcome === 'rejected'), line);
    assert.equal(createsOf(h, 'Agreement').length, 1, 'the one CREATE; nothing was sent again');
  });
}
