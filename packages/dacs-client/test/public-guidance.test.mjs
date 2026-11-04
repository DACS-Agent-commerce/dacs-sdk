// DC-CW13: the root guidance names follow the one hold constant on every call.
// Held guidance is the historical diagnostic text; admitted guidance is the full text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installPurchaseAdmissionHook, loadAdmissionDouble } from './helpers/purchase-admission-hook.mjs';
import { installPackedPair, switchedCopy } from './helpers/packed-install.mjs';

installPurchaseAdmissionHook();
const { setPurchaseAdmission } = await loadAdmissionDouble();
const { purchaseNext, PURCHASE_STATUS_HELP, protocolView } = await import('@kynesyslabs/dacs-client');
const admitted = await import('../src/purchases.mjs');
const { protocolView: admittedProtocolView } = await import('../src/dacs/protocol-purchases.mjs');

const HELD_GUIDANCE = /historical.*held/;
const STATUSES = ['agreement_pending', 'agreement_rejected', 'awaiting_approval', 'approved', 'payment_handoff', 'broadcast_reported', 'payment_uncertain',
  'settled_verified', 'payment_failed', 'payment_mismatch', 'expired', 'terms_changed', 'superseded', 'cancelled'];
const OPERATION = { status: 'awaiting_approval', terms: { protocol: {} }, state: { protocol: { stage: 'agreement-signing' } } };
const holdAfter = (t) => t.after(() => setPurchaseAdmission('held'));

test('purchaseNext, PURCHASE_STATUS_HELP and protocolView give held guidance while held and admitted guidance once the seam admits, read at each call on the same imported objects', (t) => {
  holdAfter(t);
  const expectHeld = () => {
    assert.match(purchaseNext(OPERATION), HELD_GUIDANCE);
    assert.match(PURCHASE_STATUS_HELP.awaiting_approval, HELD_GUIDANCE);
    assert.equal(protocolView(OPERATION).historical, true);
  };
  const expectAdmitted = () => {
    assert.equal(purchaseNext(OPERATION), admitted.purchaseNext(OPERATION));
    assert.equal(PURCHASE_STATUS_HELP.awaiting_approval, admitted.PURCHASE_STATUS_HELP.awaiting_approval);
    assert.deepEqual(protocolView(OPERATION), admittedProtocolView(OPERATION));
    assert.equal(protocolView(OPERATION).historical, undefined);
  };
  setPurchaseAdmission('held');
  expectHeld();
  setPurchaseAdmission('testnet-tp1');
  expectAdmitted();
  setPurchaseAdmission('held');
  expectHeld();
});

test('PURCHASE_STATUS_HELP stays a frozen map with today\'s keys, each a string', (t) => {
  holdAfter(t);
  for (const admission of ['held', 'testnet-tp1']) {
    setPurchaseAdmission(admission);
    assert.equal(Object.isFrozen(PURCHASE_STATUS_HELP), true);
    assert.deepEqual(Object.keys(PURCHASE_STATUS_HELP), STATUSES);
    for (const status of STATUSES) assert.equal(typeof PURCHASE_STATUS_HELP[status], 'string', `${status} while ${admission}`);
    assert.throws(() => { PURCHASE_STATUS_HELP.approved = 'changed'; }, TypeError);
  }
});

// Runs under the packed archive; argv[2] is the guidance the installed hold must give.
const GUIDANCE_PROBE = `
  import assert from 'node:assert/strict';
  import { purchaseNext, PURCHASE_STATUS_HELP, protocolView } from '@kynesyslabs/dacs-client';
  const operation = { status: 'awaiting_approval', terms: { protocol: {} }, state: { protocol: { stage: 'agreement-signing' } } };
  const held = process.argv[2] === 'held';
  assert.equal(/historical.*held/.test(purchaseNext(operation)), held);
  assert.equal(/historical.*held/.test(PURCHASE_STATUS_HELP.awaiting_approval), held);
  assert.equal(protocolView(operation).historical === true, held);
`;

test('from the packed archive the three names give held guidance, and from the switched-copy archive (P35\'s one-line diff, DC-CW11) the same names give admitted guidance', (t) => {
  for (const [guidance, clientDir] of [['held', undefined], ['admitted', switchedCopy(t)]]) {
    const { app, run } = installPackedPair(t, clientDir ? { clientDir } : {});
    writeFileSync(join(app, 'guidance.mjs'), GUIDANCE_PROBE);
    run(process.execPath, ['guidance.mjs', guidance], app);
  }
});
