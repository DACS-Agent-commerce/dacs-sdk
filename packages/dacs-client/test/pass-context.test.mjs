// The private per-pass context: which classes exist, who can install one, and when its
// current-authorization check lets a transmission go.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertCurrentAuthorization, currentPassContext, passContext, runInPassContext } from '../src/wallet/pass-context.mjs';

test('a pass context names a job class or none, and any other class is a TypeError', () => {
  for (const operationClass of [null, 'job-create', 'payment-evidence', 'job-resume']) assert.equal(passContext({ operationClass }).operationClass, operationClass);
  assert.equal(passContext().operationClass, null);
  for (const operationClass of ['native', 'JOB-CREATE', '', false, 7]) assert.throws(() => passContext({ operationClass }), TypeError);
});

test('only a context made by passContext runs, and the running pass sees it where other code sees the plain one', async () => {
  assert.deepEqual(currentPassContext(), { operationClass: null });
  assert.ok(Object.isFrozen(currentPassContext()));
  assert.throws(() => runInPassContext({ operationClass: null }, () => {}), TypeError);
  assert.throws(() => runInPassContext(structuredClone(passContext({ operationClass: 'job-create' })), () => {}), TypeError);
  const context = passContext({ operationClass: 'job-create', operationId: 'TEST-job', currentAuthorization: () => true });
  assert.ok(Object.isFrozen(context));
  assert.equal(await runInPassContext(context, async () => { await null; return currentPassContext(); }), context);
  assert.deepEqual(currentPassContext(), { operationClass: null }, 'the context ends with the pass');
});

test('a plain pass always may transmit; a job pass needs a check that returns true', () => {
  assertCurrentAuthorization(passContext());
  for (const operationClass of ['job-create', 'payment-evidence', 'job-resume']) {
    assert.throws(() => assertCurrentAuthorization(passContext({ operationClass })), { code: 'context_authorization_required' });
    assert.throws(() => assertCurrentAuthorization(passContext({ operationClass, currentAuthorization: 'yes' })), { code: 'context_authorization_required' });
    assertCurrentAuthorization(passContext({ operationClass, currentAuthorization: () => true }));
    for (const answer of [false, undefined, 1, 'true', {}, null]) {
      assert.throws(() => assertCurrentAuthorization(passContext({ operationClass, currentAuthorization: () => answer })), { code: 'context_authorization_refused' });
    }
  }
});

test('a check that answers asynchronously is refused and its later rejection is handled', async () => {
  const refused = new Promise((resolve, reject) => setImmediate(() => reject(new Error('TEST-late-failure'))));
  assert.throws(() => assertCurrentAuthorization(passContext({ operationClass: 'job-resume', currentAuthorization: () => refused })), { code: 'context_authorization_refused' });
  await refused.catch(() => {});
  assert.throws(() => assertCurrentAuthorization(passContext({ operationClass: 'job-resume', currentAuthorization: async () => true })), { code: 'context_authorization_refused' });
});

test('a check that throws keeps its own error', () => {
  const cause = Object.assign(new Error('TEST-credit-gone'), { code: 'TEST_credit_gone' });
  assert.throws(() => assertCurrentAuthorization(passContext({ operationClass: 'payment-evidence', currentAuthorization: () => { throw cause; } })), error => error === cause);
});
