// Starts the test-owned durable-journal child (durable-wallet-journal-child.mjs)
// as a real process and drives it over IPC. Used by the crash and lock tests.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./durable-wallet-journal-child.mjs', import.meta.url));

/**
 * Forks the child on the journal at `path` and waits until it is ready. Returns
 * its pid and journal instance, `request(op, args)` for IPC commands, `event(name)`
 * for the next event the child announces, `exited` (resolves with the exit
 * signal) and `kill()`. The child is killed when the test ends.
 */
export async function spawnJournalChild(t, { path, lockMs = 2000 }) {
  const env = { ...process.env, DACS_DURABLE_JOURNAL_PATH: path, DACS_DURABLE_JOURNAL_LOCK_MS: String(lockMs) };
  delete env.NODE_TEST_CONTEXT;
  const child = fork(CHILD, [], { env, execArgv: [] });
  const replies = new Map(), events = [], waiting = [];
  let nextId = 0;
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve(signal ?? code)));
  child.on('message', (message) => {
    if (message.event) { events.push(message); for (const wake of waiting.splice(0)) wake(); return; }
    replies.get(message.id)?.(message);
  });
  const event = async (name) => {
    for (;;) {
      const index = events.findIndex((e) => e.event === name);
      if (index >= 0) return events.splice(index, 1)[0];
      await new Promise((resolve) => waiting.push(resolve));
    }
  };
  const kill = () => child.kill('SIGKILL');
  t.after(async () => { kill(); await exited; });
  const ready = await event('ready');
  const request = (op, args = {}) => new Promise((resolve) => {
    const id = nextId += 1;
    replies.set(id, resolve);
    child.send({ id, op, ...args });
  });
  return { pid: ready.pid, instance: ready.instance, request, event, exited, kill };
}
