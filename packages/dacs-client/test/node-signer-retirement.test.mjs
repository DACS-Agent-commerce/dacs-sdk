import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSignerReservations } from '../src/wallet/signer-reservation.mjs';
import { args, open, options, signed, signer } from './helpers/signer-reservation-world.mjs';

const REQUEST = 'TEST-exact-request';
const LEDGER = { ledgerId: 'TEST-ledger', requestText: REQUEST };

test('while the write that finishes a released retirement keeps failing, reserve refuses and bindSigned stays refused; the next reserve finishes it and claims fresh', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signer-retirement-'));
  const journal = open(join(directory, 'wallet.sqlite'), 'create');
  t.after(() => { journal.close(); rmSync(directory, { recursive: true, force: true }); });
  let clearRefused = true;
  const settled = [];
  const reservations = createSignerReservations({
    ...options({
      get: key => journal.get(key),
      put: (key, value) => { if (value.active === null && clearRefused) throw new Error('TEST-put-refused'); return journal.put(key, value); },
      withWalletLock: (key, work) => journal.withWalletLock(key, work),
    }),
    openApproval: async () => null,
    settleApproval: async (ledgerId, outcome) => { settled.push([ledgerId, outcome]); },
  });
  const { reservation } = await reservations.reserve(args());
  const held = await reservations.bindApproval(await reservations.bindApprovalIntent(reservation, REQUEST), LEDGER);

  await assert.rejects(reservations.retireUnsigned(held), { message: 'TEST-put-refused' });
  await assert.rejects(reservations.reserve(args('TEST-evidence-b')), { message: 'TEST-put-refused' });
  await assert.rejects(reservations.bindSigned(held, signed()), { code: 'signer_retirement_unfinished' });
  assert.deepEqual(await reservations.current(signer), held);

  clearRefused = false;
  const next = await reservations.reserve(args('TEST-evidence-b'));
  assert.equal(next.nonce, held.active.nonce);
  assert.equal(next.reservation.active.operationKey, 'TEST-evidence-b');
  assert.notEqual(next.reservation.active.attemptId, held.active.attemptId);
  assert.deepEqual(settled, [[LEDGER.ledgerId, 'released'], [LEDGER.ledgerId, 'released'], [LEDGER.ledgerId, 'released']]);
});
