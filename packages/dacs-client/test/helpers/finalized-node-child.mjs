import { finalizedWorld, cutHistory } from './finalized-node-world.mjs';
import { OS_IDENTITY } from '../../src/wallet/holder-incarnation.mjs';

const [path, cut] = process.argv.slice(2);
process.on('message', () => {});
const world = await finalizedWorld({ after() {} }, { path, journalOptions: { lockTimeoutMs: 0 }, journalWrap: cutHistory(async record => {
  if (cut === 'signed-held' && record.state === 'signed') world.state.stopped = true;
  if (record.state !== (cut === 'recover-race' ? 'confirm-acknowledged' : cut)) return;
  await new Promise(resolve => process.send({ event: 'cut', record, namespace: OS_IDENTITY.self }, resolve));
  await new Promise(() => {}); // The parent kills us while the lane callback still owns the lock.
}) });
await world.build();
const answer = await world.send();
if (cut === 'recover-race') {
  process.send({ event: 'done', success: answer.success });
  await new Promise(() => {});
}
throw new Error('TEST-history-cut-not-reached');
