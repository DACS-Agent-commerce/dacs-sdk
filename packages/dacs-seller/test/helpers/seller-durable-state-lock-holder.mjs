// TEST child for seller-durable-state-locks.test.mjs: a live seller-state store
// in another OS process that holds one job lock until the parent says finish.
// Its ephemeral TEST key arrives over IPC and is never written anywhere. Each
// `call` runs one job-scoped write inside the held acquisition and reports its
// error code and the external calls it made (signer and anchor sink).
import { AsyncLocalStorage } from 'node:async_hooks';
import { createPrivateKey, sign } from 'node:crypto';
import { createSellerDurableState } from '../../src/dacs/seller-durable-state.mjs';

let store, jobId, finish, inside;
const effects = { signs: 0, writes: 0, reads: 0 };
const anchors = { write: async () => { effects.writes += 1; throw new Error('TEST answer lost'); }, read: async () => { effects.reads += 1; return { status: 'absent' }; } };
const calls = {
  save: () => store.saveSession({ jobId, writer: 'child' }),
  sign: () => store.signOnce('signature:child', Buffer.from('child-bytes')),
  anchor: () => store.anchor({ jobId, logicalAddress: `TEST/child/${jobId}`, artifact: { kind: 'TEST' }, anchors, authorize: () => 'TEST' }),
  bind: () => store.bindSettlement('TEST-child-settlement', jobId),
  reserve: () => store.reserveSignatureCommitment('did:demos:agent:TEST-buyer', jobId),
  releaseCommitment: () => store.releaseSignatureCommitment('did:demos:agent:TEST-buyer', jobId),
  reenter: () => store.withJob(jobId, async () => {}),
};
const reply = (message) => process.send(message);
process.on('disconnect', () => process.exit(0));
process.on('message', async (message) => {
  try {
    if (message.type === 'hold') {
      // Optional: the file-creation mask this process runs with.
      if (message.umask !== undefined) process.umask(message.umask);
      const key = createPrivateKey({ key: Buffer.from(message.pkcs8, 'base64'), format: 'der', type: 'pkcs8' });
      const signer = { claim: message.claim, sign: (bytes) => { if (!Buffer.from(bytes).toString().startsWith('dacs-chatgpt-plugin:')) effects.signs += 1; return sign(null, Buffer.from(bytes), key); } };
      store = await createSellerDurableState({ dir: message.dir, signer, listingPin: message.listingPin });
      jobId = message.jobId;
      let started = false;
      store.withJob(jobId, (session) => new Promise((resolve) => {
        started = true; finish = resolve; inside = AsyncLocalStorage.snapshot();
        reply({ type: 'hold', code: null, pid: process.pid, session, locks: store.inspectLocks() });
      })).then(() => reply({ type: 'finish', code: null, locks: store.inspectLocks() }), (error) => reply({ type: started ? 'finish' : 'hold', code: error?.code ?? 'failed' }));
    } else if (message.type === 'call') {
      const before = { ...effects };
      let code = null;
      try { await inside(calls[message.op]); } catch (error) { code = error?.code ?? 'failed'; }
      reply({ type: 'call', code, signs: effects.signs - before.signs, writes: effects.writes - before.writes, reads: effects.reads - before.reads });
    } else if (message.type === 'finish') finish();
  } catch (error) { reply({ type: 'error', error: String(error?.code ?? error?.message ?? error) }); }
});
reply({ type: 'ready' });
