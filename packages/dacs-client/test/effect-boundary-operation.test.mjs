// One effect per operation and lane: the boundary decides every signature,
// release and send from the operation's whole history on that lane, and
// authorizes right before each of them. Real journal, history and fence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createEffectFence } from '../src/wallet/effect-fence.mjs';
import { boundaryWorld, setPurchaseAdmission, code, digest, signedBytes, states, cutAppend, flush } from './helpers/effect-boundary-fixture.mjs';

const digestBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const passStates = async (w) => (await w.history.readOperation(w.op)).map((record) => `${record.passId}/${record.state}`);
const changes = {
  stop: (w) => { w.stopped = true; },
  hold: () => setPurchaseAdmission('held'),
  approval: (w) => { w.approval = { rev: 2, open: false }; },
  revision: (w) => { w.revision++; },
};
const codes = { stop: 'writes_stopped', hold: 'profile_not_admitted', approval: 'write-fee-cap', revision: 'context_admission_closed' };

async function heldArtifact(t) {
  const w = await boundaryWorld(t);
  cutAppend(w, 'signed', { mutate: () => { w.stopped = true; } });
  await assert.rejects(w.sign(), code('writes_stopped'));
  w.reopen(); w.stopped = false;
  return { w, artifact: { ...w.op, artifactHash: digestBytes(signedBytes) } };
}

test('a second signature of an operation already signed on its lane is refused eb_operation_signed without calling the signer, also after a restart, and nothing more is sent', async (t) => {
  const w = await boundaryWorld(t), artifact = await w.run();
  const signAgain = () => w.boundary.signPass(w.op, () => { w.signatures++; return Buffer.from('TEST-other-bytes'); });
  const refused = await signAgain().catch((error) => error);
  assert.equal(refused.code, 'eb_operation_signed'); assert.equal(refused.details.artifactHash, artifact.artifactHash);
  w.reopen();
  await assert.rejects(signAgain(), code('eb_operation_signed'));
  assert.equal(w.signatures, 1); assert.deepEqual(w.sent, [signedBytes]);
  assert.deepEqual([...new Set((await w.history.readOperation(w.op)).map((record) => record.artifactHash))], [artifact.artifactHash]);

  const raced = await boundaryWorld(t);
  const first = { ...raced.op, artifactHash: digestBytes(signedBytes), passId: 'p1', state: 'signed', bytes: signedBytes.toString('base64') };
  await assert.rejects(raced.boundary.signPass(raced.op, async () => { await raced.history.append(first); return Buffer.from('TEST-later-bytes'); }), code('eb_operation_signed'));
  assert.deepEqual(await passStates(raced), ['p1/signed'], 'the bytes signed meanwhile are discarded, not persisted');
});

test('in one operation, signing or dispatching a lane again after its send sends nothing more, and a second dispatch of one artifact reads back', async (t) => {
  const w = await boundaryWorld(t);
  await w.boundary.withOperation(w.op, async () => {
    const artifact = await w.sign();
    await w.send(artifact);
    await assert.rejects(w.boundary.signPass(w.op, () => Buffer.from('TEST-second')), code('eb_operation_signed'));
    await assert.rejects(w.send(artifact), code('eb_readback_required'));
    await assert.rejects(w.send(artifact, { explicit: true }), code('eb_readback_required'));
  });
  assert.deepEqual(w.sent, [signedBytes]);
  const sequential = await w.sign({ ...w.op, operationId: 'TEST-sequential', lane: 'TEST-sequential' });
  await w.send(sequential);
  await assert.rejects(w.send(sequential), code('eb_readback_required'));
  assert.equal(w.sent.length, 2);
});

test('a stop, a hold flip, a closed approval or a revision change during the authority read after persistence refuses: signPass leaves signed-held, and the boundary signer returns no signature', async (t) => {
  for (const [change, mutate] of Object.entries(changes)) {
    for (const [via, atRead, expected] of [['signPass', 3, ['signed', 'signed-held']], ['signerFor', 3, ['signed', 'signed-held']], ['signerFor', 4, ['signed', 'dispatch-started', 'dispatch-withheld']]]) {
      const w = await boundaryWorld(t);
      let reads = 0, returned;
      w.authority.state.gate = async () => { if (++reads === atRead) mutate(w); };
      const pass = via === 'signPass' ? w.sign()
        : w.boundary.signerFor(w.op, { claim: 'TEST-claim', sign: () => signedBytes }).sign(Buffer.from('TEST-request')).then((signature) => { returned = signature; });
      await assert.rejects(pass, code(codes[change]), `${change} ${via} ${atRead}`);
      assert.equal(returned, undefined); assert.equal(w.held, false);
      assert.deepEqual(await states(w, { lane: w.op.lane, artifactHash: digestBytes(signedBytes) }), expected);
    }
  }
});

test('a dispatch after a signature in one operation reads its authority again: a rejecting read or a change in between sends nothing, and an explicit resume reads it too', async (t) => {
  const failure = new Error('TEST-authority-rejects');
  const rejecting = await boundaryWorld(t);
  await rejecting.boundary.withOperation(rejecting.op, async () => {
    const artifact = await rejecting.sign();
    rejecting.authority.state.gate = async () => { throw failure; };
    await assert.rejects(rejecting.send(artifact), (error) => error === failure);
  });
  const changed = await boundaryWorld(t);
  await changed.boundary.withOperation(changed.op, async () => {
    const artifact = await changed.sign();
    changed.revision++;
    await assert.rejects(changed.send(artifact), code('context_admission_closed'));
  });
  assert.equal(rejecting.sent.length + changed.sent.length, 0);

  const { w, artifact } = await heldArtifact(t);
  let reads = 0;
  w.authority.state.gate = async () => { if (++reads === 2) throw failure; };
  await assert.rejects(w.send(artifact, { explicit: true }), (error) => error === failure);
  assert.equal(reads, 2); assert.equal(w.sent.length, 0);
  assert.deepEqual(await passStates(w), ['p1/signed', 'p1/signed-held', 'p2/signed', 'p2/dispatch-started', 'p2/dispatch-withheld']);
});

test('a signature the boundary signer returned is a possible dispatch: its history is signed then dispatch-started, and a later native dispatch reads back', async (t) => {
  const w = await boundaryWorld(t);
  const signature = await w.boundary.signerFor(w.op, { claim: 'TEST-claim', sign: () => signedBytes }).sign(Buffer.from('TEST-request'));
  assert.deepEqual(signature, signedBytes);
  const artifact = { ...w.op, artifactHash: digestBytes(signedBytes) };
  assert.deepEqual(await states(w, artifact), ['signed', 'dispatch-started']);
  await assert.rejects(w.send(artifact), code('eb_readback_required'));
  await assert.rejects(w.send(artifact, { explicit: true }), code('eb_readback_required'));
  assert.equal(w.sent.length, 0);
});

test('the operation state decides each dispatch: none, signed, held with and without explicit, possible, and two artifacts for one operation', async (t) => {
  const other = Buffer.from('TEST-other-artifact');
  for (const [name, planted, options, expected] of [
    ['none', [], {}, 'eb_history_unavailable'],
    ['signed', ['signed'], {}, null],
    ['held', ['signed', 'signed-held'], {}, 'eb_explicit_resume_required'],
    ['held explicit', ['signed', 'signed-held'], { explicit: true }, null],
    ['possible', ['signed', 'dispatch-unknown'], { explicit: true }, 'eb_readback_required'],
    ['two artifacts', ['signed', 'other-signed'], {}, 'eb_history_unavailable'],
  ]) {
    const w = await boundaryWorld(t), artifact = { ...w.op, artifactHash: digestBytes(signedBytes) };
    for (const state of planted) {
      if (state === 'other-signed') await w.history.append({ ...w.op, artifactHash: digestBytes(other), passId: 'p1', state: 'signed', bytes: other.toString('base64') });
      else await w.history.append({ ...artifact, passId: 'p1', state, ...(state === 'signed' ? { bytes: signedBytes.toString('base64') } : {}) });
    }
    const sending = w.send(artifact, options);
    if (expected) await assert.rejects(sending, code(expected), name); else await sending;
    assert.equal(w.sent.length, expected ? 0 : 1, name);
  }
});

test('a held resume starts pass p2 and reuses it after a crash; a p2 another resume recorded first refuses with nothing sent', async (t) => {
  const crashed = await heldArtifact(t);
  cutAppend(crashed.w, 'dispatch-started');
  await assert.rejects(crashed.w.send(crashed.artifact, { explicit: true }));
  crashed.w.reopen();
  await crashed.w.send(crashed.artifact, { explicit: true });
  assert.deepEqual(await passStates(crashed.w), ['p1/signed', 'p1/signed-held', 'p2/signed', 'p2/dispatch-started', 'p2/dispatch-acknowledged']);
  assert.deepEqual(crashed.w.sent, [signedBytes]);

  const { w, artifact } = await heldArtifact(t);
  const append = w.history.append;
  w.history.append = async (record) => {
    if (record.passId === 'p2' && record.state === 'signed') {
      w.history.append = append;
      await append(record);
      await append({ ...artifact, passId: 'p2', state: 'dispatch-started' });
    }
    return append(record);
  };
  await assert.rejects(w.send(artifact, { explicit: true }), code('eb_persist_failed'));
  await assert.rejects(w.send(artifact, { explicit: true }), code('eb_readback_required'));
  assert.equal(w.sent.length, 0);
});

test('a failed signed-held write rejects with the original refusal, and the next pass checks the stop again before recording or sending anything', async (t) => {
  const w = await boundaryWorld(t);
  cutAppend(w, 'signed', { mutate: () => { w.stopped = true; } });
  cutAppend(w, 'signed-held', { error: Object.assign(new Error('TEST-held-write'), { code: 'EIO' }) });
  await assert.rejects(w.sign(), code('writes_stopped'));
  const artifact = { ...w.op, artifactHash: digestBytes(signedBytes) };
  w.reopen();
  await assert.rejects(w.send(artifact), code('writes_stopped'));
  assert.deepEqual(await states(w, artifact), ['signed']);
  assert.equal(w.sent.length, 0);
});

test('two signPass calls running together in one withOperation sign one artifact: the later one is refused eb_operation_signed, and the artifact still dispatches', async (t) => {
  const w = await boundaryWorld(t);
  const append = w.history.append;
  w.history.append = async (record) => { await flush(); return append(record); };
  const signAs = (bytes) => w.boundary.signPass(w.op, async () => { await flush(); w.signatures++; return Buffer.from(bytes); });
  const outcomes = await w.boundary.withOperation(w.op, () => Promise.allSettled([signAs('TEST-bytes-a'), signAs('TEST-bytes-b')]));
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ['fulfilled', 'rejected']);
  assert.equal(outcomes[1].reason.code, 'eb_operation_signed');
  assert.equal(w.signatures, 1, 'the later signer is never called');
  assert.deepEqual(await passStates(w), ['p1/signed']);
  await w.send(outcomes[0].value);
  assert.deepEqual(w.sent, [Buffer.from('TEST-bytes-a')]);
});

test('a signPass that fails leaves its operation free: the next signPass signs it', async (t) => {
  const w = await boundaryWorld(t);
  const outcomes = await w.boundary.withOperation(w.op, () => Promise.allSettled([
    w.boundary.signPass(w.op, async () => { await flush(); throw new Error('TEST-signer-failed'); }),
    w.boundary.signPass(w.op, () => signedBytes),
  ]));
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ['rejected', 'fulfilled']);
  assert.match(outcomes[0].reason.message, /TEST-signer-failed/);
  assert.deepEqual(await passStates(w), ['p1/signed']);
});

test('withOperation rejects a malformed operation instead of throwing', async (t) => {
  const w = await boundaryWorld(t);
  let result;
  assert.doesNotThrow(() => { result = w.boundary.withOperation({ lane: 'TEST-lane' }, () => {}); });
  await assert.rejects(result, TypeError);
});

// The boundary over a fence whose release fails after the work ran. The history is shared
// with the world's own boundary, so an artifact is signed through the healthy one first.
async function worldWithFailingRelease(t) {
  const w = await boundaryWorld(t), releaseFailure = new Error('TEST-release-failed');
  const fence = createEffectFence({ currentLocal: () => digest(w.currentLocal()), acquire: async () => ({ release: () => { throw releaseFailure; } }) });
  const artifact = await w.sign();
  w.resetBoundary({ fence });
  return { w, artifact, releaseFailure };
}

test('a fence release that fails after a successful send reports eb_fence_release_failed with the send result, and a retry reads back instead of sending again', async (t) => {
  const { w, artifact, releaseFailure } = await worldWithFailingRelease(t);
  await assert.rejects(w.send(artifact), (error) => error.code === 'eb_fence_release_failed' && error.details?.result === 'TEST-ack' && error.cause === releaseFailure);
  assert.deepEqual(await passStates(w), ['p1/signed', 'p1/dispatch-started', 'p1/dispatch-acknowledged']);
  w.reopen();
  await assert.rejects(w.send(artifact), code('eb_readback_required'));
  assert.deepEqual(w.sent, [signedBytes]);
});

test('a fence release that fails after withOperation work reports eb_fence_release_failed with the work result', async (t) => {
  const { w, releaseFailure } = await worldWithFailingRelease(t);
  const operation = { ...w.op, operationId: 'TEST-other-operation', lane: 'TEST-other-lane' };
  const failed = await w.boundary.withOperation(operation, async () => ({ sentBy: 'TEST-work' })).catch((error) => error);
  assert.equal(failed.code, 'eb_fence_release_failed');
  assert.deepEqual(failed.details, { result: { sentBy: 'TEST-work' } });
  assert.equal(failed.cause, releaseFailure);
});

test('a fence release that fails after a successful signPass reports eb_fence_release_failed with the artifact, which stays signed', async (t) => {
  const { w } = await worldWithFailingRelease(t);
  const operation = { ...w.op, operationId: 'TEST-other-operation', lane: 'TEST-other-lane' };
  const failed = await w.boundary.signPass(operation, () => signedBytes).catch((error) => error);
  assert.equal(failed.code, 'eb_fence_release_failed');
  assert.equal(failed.details.result.artifactHash, digestBytes(signedBytes));
  await assert.rejects(w.boundary.signPass(operation, () => signedBytes), code('eb_operation_signed'));
});

test('a send that fails keeps its own error when the fence release also fails', async (t) => {
  const { w, artifact } = await worldWithFailingRelease(t);
  const sendFailure = new Error('TEST-send-failed');
  await assert.rejects(w.boundary.dispatchPass(artifact, () => { throw sendFailure; }), (error) => error === sendFailure);
});

for (const path of ['sign', 'dispatch']) {
  test(`a nested ${path} while held refuses before reading or changing history`, async (t) => {
    const w = await boundaryWorld(t);
    await w.boundary.withOperation(w.op, async () => {
      const artifact = await w.sign();
      let reads = 0;
      const read = w.history.readOperation;
      w.history.readOperation = (...args) => { reads++; return read(...args); };
      setPurchaseAdmission('held');
      await assert.rejects(path === 'sign' ? w.sign() : w.send(artifact), code('profile_not_admitted'));
      assert.equal(reads, 0);
      assert.deepEqual(await passStates(w), ['p1/signed']);
    });
    assert.equal(w.sent.length, 0);
    assert.equal(w.signatures, 1);
  });
}

for (const barrier of ['history read', 'fresh signed write']) {
  test(`a hold during the dispatch ${barrier} refuses before intent is saved`, async (t) => {
    const w = await boundaryWorld(t), artifact = await w.sign();
    await w.history.append({ ...artifact, passId: 'p1', state: 'signed-held' });
    if (barrier === 'history read') {
      const read = w.history.readOperation;
      w.history.readOperation = async (...args) => { const records = await read(...args); setPurchaseAdmission('held'); return records; };
    } else {
      cutAppend(w, 'signed', { mutate: () => setPurchaseAdmission('held') });
    }
    await assert.rejects(w.send(artifact, { explicit: true }), code('profile_not_admitted'));
    assert.equal(w.sent.length, 0);
    assert.deepEqual(await passStates(w), barrier === 'history read'
      ? ['p1/signed', 'p1/signed-held'] : ['p1/signed', 'p1/signed-held', 'p2/signed']);
  });
}

test('an invalid send is refused without changing signed history, leaving a valid dispatch available', async (t) => {
  const w = await boundaryWorld(t), artifact = await w.sign();
  for (const send of [undefined, null, {}, 'TEST-send']) {
    await assert.rejects(w.boundary.dispatchPass(artifact, send), TypeError);
    assert.deepEqual(await passStates(w), ['p1/signed']);
  }
  await w.send(artifact);
  assert.deepEqual(w.sent, [signedBytes]);
});

for (const via of ['signPass', 'signerFor']) {
  test(`a stalled ${via} is aborted on its own deadline and releases the fence without retaining late bytes`, async (t) => {
    const w = await boundaryWorld(t);
    let signal, finish, entered;
    const started = new Promise(resolve => { entered = resolve; });
    w.authority.state.gate = async () => { w.clock.advance(1000); };
    const sign = (options) => { signal = options?.signal; entered(); return new Promise(resolve => { finish = resolve; }); };
    const pending = via === 'signPass' ? w.boundary.signPass(w.op, sign)
      : w.boundary.signerFor(w.op, { claim: 'TEST-claim', sign: (_bytes, options) => sign(options) }).sign(Buffer.from('TEST-request'));
    let outcome;
    const settled = pending.then(result => { outcome = result; }, error => { outcome = error; });
    await started;
    // The signer's deadline is its own, whatever the earlier authority reads used.
    const deadlineMs = 10000;
    w.clock.advance(deadlineMs - 1); await flush();
    assert.equal(outcome, undefined);
    w.clock.advance(1); await flush();
    assert.equal(outcome?.code, 'eb_sign_timeout');
    await settled;
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason, outcome);
    assert.equal(w.held, false);
    assert.deepEqual(await passStates(w), []);
    finish(signedBytes); await flush();
    assert.deepEqual(await passStates(w), []);
    assert.equal(w.clock.timers.size, 0);
    w.authority.state.gate = null;
    await w.sign();
    await w.sign({ ...w.op, operationId: 'TEST-next', lane: 'TEST-next' });
    assert.equal(w.signatures, 2);
  });
}

test('a signer that returns before its deadline is not refused for the time it used, even when authority reads are slow', async (t) => {
  const w = await boundaryWorld(t);
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  w.authority.state.gate = async () => { w.clock.advance(1000); };
  const pending = w.boundary.signPass(w.op, () => { entered(); return new Promise(resolve => { finish = resolve; }); });
  await started;
  w.clock.advance(7500); finish(signedBytes);
  const artifact = await pending;
  assert.equal(artifact.artifactHash, digestBytes(signedBytes));
  assert.deepEqual(await passStates(w), ['p1/signed']);
  assert.equal(w.held, false);
});

test('the stop check is called with no arguments', async (t) => {
  const w = await boundaryWorld(t);
  const calls = [];
  w.resetBoundary({ stopped: (...args) => { calls.push(args); return args.length > 0; } });
  await w.sign();
  assert.ok(calls.length > 0);
  assert.deepEqual(calls.filter(args => args.length > 0), []);
});

test('a fence release failure after the boundary signer retains its signature, cause and records and refuses another sign', async (t) => {
  const { w, releaseFailure } = await worldWithFailingRelease(t);
  const operation = { ...w.op, operationId: 'TEST-signer', lane: 'TEST-signer' };
  let signatures = 0;
  const signature = 'TEST-signature';
  const signer = w.boundary.signerFor(operation, { claim: 'TEST-claim', sign: () => { signatures++; return signature; } });
  const failed = await signer.sign(Buffer.from('TEST-request')).catch(error => error);
  assert.equal(failed.code, 'eb_fence_release_failed');
  assert.equal(failed.details.result, signature);
  assert.equal(failed.cause, releaseFailure);
  const records = await w.history.readOperation(operation);
  assert.deepEqual(records.map(record => record.state), ['signed', 'dispatch-started']);
  assert.equal(records[0].bytes, Buffer.from(signature).toString('base64'));
  await assert.rejects(signer.sign(Buffer.from('TEST-request')), code('eb_operation_signed'));
  assert.equal(signatures, 1);
});

test('connection replacement preserves the fence release error after the replacement succeeds', async (t) => {
  const { w, releaseFailure } = await worldWithFailingRelease(t);
  let replaced = false;
  await assert.rejects(w.boundary.replaceConnection(() => { replaced = true; return 'TEST-result'; }), error => error === releaseFailure);
  assert.equal(replaced, true);
});

test('a queued nested sign checks admission before reading history when the earlier signer fails', async (t) => {
  const w = await boundaryWorld(t);
  await w.boundary.withOperation(w.op, async () => {
    let entered, fail;
    const started = new Promise(resolve => { entered = resolve; });
    const first = w.boundary.signPass(w.op, () => { entered(); return new Promise((_resolve, reject) => { fail = reject; }); });
    const firstRefused = assert.rejects(first, /TEST-sign-failed/);
    await started;
    let reads = 0;
    const read = w.history.readOperation;
    w.history.readOperation = (...args) => { reads++; return read(...args); };
    const second = w.sign();
    await flush();
    setPurchaseAdmission('held');
    fail(new Error('TEST-sign-failed'));
    await firstRefused;
    await assert.rejects(second, code('profile_not_admitted'));
    assert.equal(reads, 0);
    assert.equal(w.signatures, 0);
    assert.deepEqual(await passStates(w), []);
  });
});

test('signPass without confirmedDebitOs checks the recorded debit and with it checks only the fee view', async (t) => {
  // The ceiling is 50 DEM; the recorded debit is far above it, the fee view is under it.
  const OVER = '90000000000', FEE_VIEW = '2300000000';
  const signWith = (w, options) => w.boundary.signPass({ ...w.op, debitOs: OVER }, () => { w.signatures++; return signedBytes; }, options);
  const artifactStates = (w) => states(w, { lane: w.op.lane, artifactHash: digestBytes(signedBytes) });

  const plain = await boundaryWorld(t);
  await assert.rejects(signWith(plain), code('write-fee-cap'), 'without the option the recorded debit is checked');
  assert.equal(plain.signatures, 0);

  const viewed = await boundaryWorld(t);
  const artifact = await signWith(viewed, { confirmedDebitOs: FEE_VIEW });
  assert.equal(viewed.signatures, 1);
  assert.equal(artifact.debitOs, OVER, 'the returned artifact keeps the recorded debit');
  const [signed] = await viewed.history.readOperation(viewed.op);
  assert.equal(signed.state, 'signed');
  assert.equal(signed.debitOs, OVER, 'the persisted record keeps the recorded debit');

  for (const confirmedDebitOs of ['50000000001', null]) {
    const w = await boundaryWorld(t);
    await assert.rejects(signWith(w, { confirmedDebitOs }), code('write-fee-cap'), String(confirmedDebitOs));
    assert.equal(w.signatures, 0, String(confirmedDebitOs));
    assert.deepEqual(await artifactStates(w), [], `${confirmedDebitOs}: no record`);
  }

  // The check after the signed record is persisted reads the view too: only the stop refuses there.
  const stopped = await boundaryWorld(t);
  cutAppend(stopped, 'signed', { mutate: () => { stopped.stopped = true; } });
  await assert.rejects(signWith(stopped, { confirmedDebitOs: FEE_VIEW }), code('writes_stopped'));
  assert.deepEqual(await artifactStates(stopped), ['signed', 'signed-held']);
});
