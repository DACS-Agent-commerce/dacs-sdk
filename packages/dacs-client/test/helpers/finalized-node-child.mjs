// A real child process for the lock-recovery tests: it runs one send on a journal the parent prepared and stops at a chosen history record,
// still holding the journal's lane lock, until the parent kills it. With the cut 'recover-race' it resumes the retained confirmation instead.
import { finalizedWorld, cutHistory } from './finalized-node-world.mjs';
const { resumeRetainedConfirmation } = await import('./resume-retained-confirmation.mjs');
const { OS_IDENTITY } = await import('../../src/wallet/holder-incarnation.mjs');

const [path, cut] = process.argv.slice(2);
process.on('message', () => {});
const world = await finalizedWorld({ after() {} }, { path, journalOptions: { lockTimeoutMs: 0 }, journalWrap: cutHistory(async record => {
  if (cut === 'signed-held' && record.state === 'signed') world.state.stopped = true;
  if (record.state !== (cut === 'recover-race' ? 'confirm-acknowledged' : cut)) return;
  await new Promise(resolve => process.send({ event: 'cut', record, namespace: OS_IDENTITY.self }, resolve));
  await new Promise(() => {}); // The parent kills us while the lane callback still owns the lock.
}) });
await world.build();
if (cut === 'recover-race') {
  const answer = await resumeRetainedConfirmation(world).then(() => ({ success: true }), () => ({ success: false }));
  process.send({ event: 'done', success: answer.success });
  await new Promise(() => {});
}
await world.send();
throw new Error('TEST-history-cut-not-reached');
