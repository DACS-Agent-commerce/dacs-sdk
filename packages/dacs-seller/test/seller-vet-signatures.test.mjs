// The Vet component signatures and the seller's identity presentation go through an issued runCreate: the effect boundary's
// stop check and final checks run right before the operator wallet is called, and a lost save never asks the wallet again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { orchestratorFixture } from './helpers/vet-orchestrator-fixture.mjs';
import { productionFixture } from './helpers/vet-production-fixture.mjs';
import { TEST_CONNECTION } from './helpers/wire-authority-fixture.mjs';

const guard = await import('../src/kit-operation-guard.mjs');
const ROLES = ['buyer', 'seller'];

// The party's composite signing step, as the party Vet store keeps it: `{ step, signing }`.
function compositeStep(row, role) {
  const ops = row?.ops?.[role];
  const key = ops && Object.keys(ops.steps).find((name) => JSON.parse(name).step === 'composite');
  return key === undefined ? null : { step: ops.steps[key], signing: ops.signing[key] };
}

// Runs one W provider resolution whose purchase check reads `open.value`, and answers its outcome or error.
const resolveOnce = (f, open = { value: true }) => f.provider().resolveBuyer(f.input, { writable: () => open.value }).then((value) => ({ value }), (error) => ({ error }));

test('both Vets\' component signatures are counted apart from transaction signatures; a stop, a re-hold, a compensation that advances the K1 rev, or a reconnect that does not take the fence, inside the final write-ahead await, signs nothing; the unchanged control signs once per role and retains the signature before the CREATE', async (t) => {
  t.after(() => guard.setKitOperationGuardForTest('testnet-tp1'));
  const cases = [
    ['a stop', (f) => { f.controls.stopped = true; }, 'seller_stopped'],
    ['a re-hold', () => { guard.setKitOperationGuardForTest('off'); }, 'kit_operation_guard_off'],
    ['a compensation that advances the K1 rev', (f, open) => { open.value = 'TEST-rev-advanced'; }, 'not-pending'],
    ['a reconnect that does not take the fence', (f) => { f.controls.connection = { ...TEST_CONNECTION, connectionId: 'TEST-reconnected' }; }, 'tp1_local_binding_changed'],
  ];
  for (const [label, change, code] of cases) for (const role of ROLES) {
    const f = await orchestratorFixture(t), open = { value: true };
    f.when(role, 'bytes', async () => change(f, open));
    const outcome = await resolveOnce(f, open);
    guard.setKitOperationGuardForTest('testnet-tp1');
    const kept = compositeStep(await f.row(), role);
    assert.ok(kept?.signing?.signedBytes, `${label}, ${role}: the bytes were written ahead`);
    assert.equal(kept.signing.signature, undefined, `${label}, ${role}: nothing was signed for the role`);
    const reached = f.controls.signatures.filter((bytes) => bytes === Buffer.from(kept.signing.signedBytes, 'hex').toString());
    assert.deepEqual(reached, [], `${label}, ${role}: the wallet was never asked for those bytes`);
    const codes = [];
    for (let link = outcome.error; link; link = link.cause ?? link.errors?.[0]) codes.push(link.code);
    assert.ok(outcome.value?.disposition !== 'present' && (codes.includes(code) || JSON.stringify(outcome.value ?? {}).includes(code)), `${label}, ${role}: refused with ${code}: ${codes} ${JSON.stringify(outcome.value)}`);
  }

  const control = await orchestratorFixture(t, { real: true });
  const events = [];
  control.controls.beforeSign = (bytes) => { events.push(['sign', Buffer.from(bytes).toString()]); };
  control.controls.beforePublish = ({ logicalAddress }) => { events.push(['create', logicalAddress]); };
  const answer = await control.run();
  assert.equal(answer.disposition, 'present', 'the unchanged control completes');
  assert.equal(control.controls.signatures.length, 2, 'one component signature per role, on the wallet\'s byte signer');
  assert.equal(control.native.captured.length, 2, 'the two CREATEs are transaction signatures, asked of the wallet apart from the component signatures');
  const row = await control.row();
  for (const role of ROLES) {
    const kept = compositeStep(row, role);
    assert.equal(typeof kept.signing.signature, 'string', `${role}: the signature is retained`);
    const signedAt = events.findIndex(([kind, value]) => kind === 'sign' && value === Buffer.from(kept.signing.signedBytes, 'hex').toString());
    assert.ok(signedAt >= 0 && events.slice(signedAt).some(([kind]) => kind === 'create'), `${role}: signed before a CREATE`);
  }
  assert.ok(events.findIndex(([kind]) => kind === 'create') > events.findIndex(([kind]) => kind === 'sign'), 'the first signature precedes the first CREATE');
});

test('a pass refusal or a store failure between the Vet signing reservation and signBytes leaves the step retryable or ends it, and never leaves it pending', async (t) => {
  for (const role of ROLES) {
    const refused = await orchestratorFixture(t);
    refused.when(role, 'bytes', async () => { refused.controls.stopped = true; });
    assert.ok((await resolveOnce(refused)).error, `${role}: the pass refusal fails the step`);
    const ended = compositeStep(await refused.row(), role);
    assert.notEqual(ended?.step?.state, 'pending', `${role}: a pass refusal never leaves the step pending`);
    assert.equal(ended?.signing?.signature, undefined, `${role}: nothing was signed for the role`);
    assert.ok(!refused.controls.signatures.includes(Buffer.from(ended?.signing?.signedBytes ?? '', 'hex').toString()), `${role}: the wallet was never asked for its bytes`);
    refused.controls.stopped = false;
    const retried = await resolveOnce(refused);
    assert.ok(retried.value?.disposition === 'present' || retried.error, `${role}: the next resolution completes or reports the ended step`);
    assert.notEqual(compositeStep(await refused.row(), role)?.step?.state, 'pending', `${role}: and still nothing is pending`);

    const failing = await orchestratorFixture(t);
    const update = failing.store.update;
    // The next write after the reservation fails once with the store's busy refusal; later writes succeed.
    failing.when(role, 'reserved', async () => {
      failing.store.update = async () => { failing.store.update = update; throw Object.assign(new Error('TEST store busy'), { code: 'journal-busy' }); };
    });
    const signedBefore = failing.controls.signatures.length;
    const failed = await resolveOnce(failing);
    failing.store.update = update;
    assert.ok(failed.error, `${role}: the store failure fails the step`);
    assert.equal(compositeStep(await failing.row(), role)?.signing?.signature, undefined, `${role}: nothing was signed for the role before the store failed`);
    assert.ok(failing.controls.signatures.length >= signedBefore);
    assert.notEqual(compositeStep(await failing.row(), role)?.step?.state, 'pending', `${role}: a store failure never leaves the step pending`);
    const again = await resolveOnce(failing);
    assert.equal(again.value?.disposition, 'present', `${role}: the busy store left the step retryable, and the retry completes`);
  }
});

test('a lost save between a Vet or presentation signature and its record reconciles the retained evidence or stays explicitly indeterminate; the wallet is never asked to sign again', async (t) => {
  for (const role of ROLES) {
    const f = await orchestratorFixture(t);
    f.when(role, 'signature', async () => { throw new Error('TEST signature save acknowledgement lost'); });
    const first = await resolveOnce(f);
    const bytes = Buffer.from(compositeStep(await f.row(), role).signing.signedBytes, 'hex').toString();
    assert.ok(first.error && f.controls.signatures.includes(bytes), `${role}: the lost save fails the resolution after the role's signature`);
    const second = await resolveOnce(f);
    assert.equal(f.controls.signatures.filter((signed) => signed === bytes).length, 1, `${role}: the wallet is never asked to sign the same bytes again`);
    assert.equal(new Set(f.controls.signatures).size, f.controls.signatures.length, `${role}: no bytes were signed twice`);
    assert.ok(second.value?.disposition === 'present' || second.error?.code !== undefined, `${role}: the retained signature completes the step, or the step is reported explicitly`);
  }

  const p = productionFixture();
  t.after(() => p.base.close());
  const store = p.config.store;
  let armed = true;
  p.config.store = { ...store, update: async (key, change) => {
    let lost = false;
    const result = await store.update(key, (old, rows) => {
      const next = change(old, rows);
      lost = armed && !old?.presentation?.bundle?.presentation && Boolean(next?.presentation?.bundle?.presentation);
      if (lost) armed = false;
      return next;
    });
    if (lost) throw new Error('TEST presentation save acknowledgement lost');
    return result;
  } };
  await assert.rejects(p.run(), /acknowledgement lost/);
  assert.equal(p.controls.presentationSigns, 1, 'the presentation was signed once');
  const retry = await p.run().then(() => null, (error) => error);
  assert.equal(p.controls.presentationSigns, 1, 'the retry never asks the wallet to sign the presentation again');
  assert.ok(retry === null || retry.code === 'seller_presentation_indeterminate', `the retry reconciles or stays explicitly indeterminate: ${retry?.code}`);
});

test('the presentation\'s pass refusal before the wallet is called puts its reservation back to prepared, so a retry signs it once', async (t) => {
  const p = productionFixture();
  t.after(() => p.base.close());
  let stopBeforePresentation = true;
  // The stop lands while the presentation reservation is written, before its pass checks the stop.
  const store = p.config.store;
  p.config.store = { ...store, update: async (key, change) => {
    const result = await store.update(key, change);
    if (stopBeforePresentation && result?.presentation?.signing?.state === 'pending') { stopBeforePresentation = false; p.controls.stopped = true; }
    return result;
  } };
  await assert.rejects(p.run(), (error) => JSON.stringify([error.code, error.cause?.code, error.errors?.map((e) => e.code)]).includes('seller_stopped'));
  assert.equal(p.controls.presentationSigns, 0, 'nothing was signed');
  const [, row] = (await p.base.entries()).find(([, value]) => value?.presentation) ?? [];
  assert.equal(row?.presentation?.signing?.state, 'prepared', 'the reservation is back to prepared');
  p.controls.stopped = false;
  await p.run();
  assert.equal(p.controls.presentationSigns, 1, 'the retry signs the presentation once');
});
