// Unshipped test child: opens the host's stages over the production wallet-session port in the directory given as the first
// argument, with the scripted node kept in the state file given as the second, and finalizes them under the seller state lock.
// At the first state-lock check made once finalize has opened the issuance journals, before the anchor handle is bound, it
// kills itself with SIGKILL.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { COMPOSITION_JOURNAL, replayNode } from './seller-node-wallet-world.mjs';
import { walletSessionWorld } from './seller-wallet-session-world.mjs';

const [directory, stateFile] = process.argv.slice(2);
const world = await walletSessionWorld({ after() {} }, { directory, node: replayNode(stateFile) });
const killedOnceJournalsOpen = { path: world.lock.path, release: () => world.lock.release(), held: () => {
  if (existsSync(join(directory, COMPOSITION_JOURNAL))) process.kill(process.pid, 'SIGKILL');
  return world.lock.held();
} };
await world.stages.finalize({ dataDirectory: directory, stopped: async () => false, stateLock: killedOnceJournalsOpen });
