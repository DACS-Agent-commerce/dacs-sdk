// One effect per operation and lane: the boundary decides every signature,
// release and send from the operation's whole history on that lane, and
// authorizes right before each of them. Real journal, history and fence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { boundaryWorld, setPurchaseAdmission, code, signedBytes, states, cutAppend } from './helpers/effect-boundary-fixture.mjs';

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

test('withOperation rejects a malformed operation instead of throwing', async (t) => {
  const w = await boundaryWorld(t);
  let result;
  assert.doesNotThrow(() => { result = w.boundary.withOperation({ lane: 'TEST-lane' }, () => {}); });
  await assert.rejects(result, TypeError);
});
