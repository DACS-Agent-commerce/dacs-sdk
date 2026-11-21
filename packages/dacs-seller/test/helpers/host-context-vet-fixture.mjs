// Unshipped fixture for the Vet evidence tests of the composed host (host-context-vet-evidence.test.mjs): their stand-in context provider,
// and a host started in a child process so that a test can stop it abruptly with SIGKILL, as a killed process or a power loss stops it.
// A clean `close()` lets an admitted context step run to its own outcome; a killed process leaves its row running with its slot, which the
// next start's startup sweep fences.
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compositeVerificationAddress } from '@kynesyslabs/dacs';
import { contextCapability } from './host-context-client.mjs';
import { JOB, buyer, seller } from './protocol-fixture.mjs';

export const VET = 'CompositeVerificationRecord';
export const ADDRESS = Object.freeze({ buyer: compositeVerificationAddress(JOB, buyer.claim), seller: compositeVerificationAddress(JOB, seller.claim) });
const WORKER = new URL('./host-context-vet-worker.mjs', import.meta.url);

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

/**
 * A context provider that publishes the Vet records `writes` names through `anchor`, each after asking the attempt's predicate, and then
 * fails by itself; with `stall` it first waits on `gate`, so that the host's deadline or the kill of its process ends the attempt. `seen`
 * counts the host's calls.
 */
export function vetProvider(anchor, writes, { stall }) {
  const gate = deferred(), entered = deferred(), seen = { resolves: 0, recovers: 0, resumes: 0 };
  const resolveBuyer = async (input, options) => {
    seen.resolves++;
    for (const party of Object.keys(writes)) {
      if (options.writable() !== true) throw Object.assign(new Error('TEST the purchase is no longer pending'), { code: 'not-pending' });
      await anchor.publish({ logicalAddress: ADDRESS[party], artifact: { TEST: 'vet-record', jobId: input.scope.jobId, party }, artifactKind: VET });
    }
    if (stall) { entered.resolve(); await gate.promise; }
    throw new Error('TEST the provider failed after its Vet write');
  };
  const recoverBuyer = async () => { seen.recovers++; return null; };
  const resumableBuyer = async () => { seen.resumes++; return null; };
  return { gate, entered, seen, capability: contextCapability({ resolveBuyer, recoverBuyer, resumableBuyer }) };
}

/**
 * A seller host on `f`'s data directory in a child process (host-context-vet-worker.mjs), started as `f.start` starts one, with
 * `vetProvider(…, writes, { stall: true })` as its context provider. The artifact anchor stays in this process: every call the host or its
 * provider makes to the anchor is answered here by `anchor`, so what the anchor holds outlives the child, as a node outlives the host.
 * `host` has the child host's `url` and `listingPin`; `entered.promise` resolves with the child provider's `seen` once its work holds
 * after the Vet writes; `kill()` stops the process with SIGKILL and resolves once it has exited. The child gets its own temporary
 * directory for the fixture's files, removed with the child when the test ends.
 */
export async function vetHostProcess(t, f, anchor, writes) {
  const temporary = await mkdtemp(join(tmpdir(), 'TEST-host-context-process-'));
  const child = fork(WORKER, [], { env: { ...process.env, TMPDIR: temporary }, serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  const kill = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; };
  t.after(async () => { await kill(); await rm(temporary, { recursive: true, force: true }); });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const started = deferred(), entered = deferred();
  entered.promise.catch(() => {});
  child.on('message', (message) => {
    if (message.type === 'anchor') {
      const answer = (reply) => { if (child.connected) child.send({ type: 'anchor', id: message.id, ...reply }); };
      Promise.resolve().then(() => anchor[message.method](message.input))
        .then((value) => answer({ value }), (error) => answer({ error: { message: error.message, code: error.code } }));
    } else if (message.type === 'started') started.resolve(message);
    else if (message.type === 'entered') entered.resolve(message.seen);
  });
  exited.then(([code, signal]) => {
    const ended = new Error(`TEST the host process ended (${signal ?? code}): ${stderr}`);
    started.reject(ended);
    entered.reject(ended);
  }, () => {});
  child.send({ type: 'start', dataDirectory: f.dataDirectory, writes });
  const { url, listingPin } = await started.promise;
  return { host: { url, listingPin }, entered: { promise: entered.promise }, kill };
}
