// Kills a real seller process at a named step of a payment and reopens the seller's stores in a new process.
//
// `killAndReopen(t, { world, killAt })` starts a child over empty directories. The child runs one payment in the fixture world or the native
// world (their `onEvent` hook reports each step) and kills itself with SIGKILL when it reaches `killAt`. A second child then opens the same
// directories and recovers the payment. The parent keeps what must outlive the first child: every event the child reported (a tape the child
// appends to before each step goes on) and the signed source records the child dumped just before it died. The second child rebuilds its
// local sources from those records; opening the seller's directory alone would not give it the node, the anchors or the Agreements.
//
// The kill points, in the order a payment reaches them:
//   receiptGranted   the permit is durable and the work save is about to be signed (fixture world only: the native seller's grant and
//                    work save are writes inside the agent with no point to stop at)
//   workSaved        the payment work is durable and the evidence is about to be signed (native: the wallet is asked to sign the CREATE)
//   evidenceSigned   the evidence is signed and its CREATE is about to be written (native: the wallet kept the signed CREATE and sends it)
//   createBroadcast  the evidence CREATE reached the chain
//   deliveryWritten  the delivery evidence reached the chain
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserialize, serialize } from 'node:v8';

const CHILD_DEADLINE_MS = 300_000;
const KILL_POINTS = ['receiptGranted', 'workSaved', 'evidenceSigned', 'createBroadcast', 'deliveryWritten'];
const DIRECTORY_NAMES = { fixture: ['agent', 'wire'], native: ['data', 'wallet'] };
const RECEIPTS_FILE = { fixture: ['agent', 'sdk-receipts', 'seller-receipts.json'], native: ['data', 'seller', 'sdk-receipts', 'seller-receipts.json'] };
// A write to a chain address is told apart by its address; the evidence CREATE and the delivery evidence end a kill point once written.
const WRITE_ROLES = [['dacs4:payment:', 'evidenceCreates'], ['dacs4:deliverable:', 'deliverableWrites'], ['dacs4:evidence:', 'deliveryEvidenceWrites']];
const KILL_AFTER_WRITE = { evidenceCreates: 'createBroadcast', deliveryEvidenceWrites: 'deliveryWritten' };
const roleOf = (address) => WRITE_ROLES.find(([prefix]) => address.startsWith(prefix))?.[1] ?? null;

// ---- The child: one payment step in a world, killed at `killAt` or run to the end ----

function childEvents({ tape, killAt }) {
  let retain = null;
  const record = (event) => appendFileSync(tape, `${JSON.stringify(event)}\n`);
  const onEvent = (name, detail = {}) => {
    const role = name === 'write' ? roleOf(detail.address) : null;
    record({ name, ...detail, ...(role === null ? {} : { role }) });
    const point = name === 'write' ? KILL_AFTER_WRITE[role] : name;
    if (retain === null || point !== killAt) return;
    record({ name: 'retained', dump: serialize(retain()).toString('base64') });
    record({ name: 'killed', at: killAt });
    process.kill(process.pid, 'SIGKILL');
    // The signal ends the process; until it does, no further step may run.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  };
  return { onEvent, keepRetaining: (retainWorld) => { retain = retainWorld; } };
}

async function runFixturePayment({ spec, t, onEvent, keepRetaining }) {
  const { fixturePaymentWorld } = await import('./wire-payment-fixture.mjs');
  const { PATHS, operationOf } = await import('./wire-routes-world.mjs');
  const w = await fixturePaymentWorld(t, { directories: spec.directories, retained: spec.retained && deserialize(Buffer.from(spec.retained, 'base64')), onEvent });
  keepRetaining(w.retain);
  if (spec.retained === null) { await w.pay(); return {}; }
  const workRetained = w.work() !== undefined;
  w.lapse();
  const { status, body } = await w.pay();
  return { delivered: body.status, workRetained, answer: { status, body }, attempt: operationOf(w, w.jobId, PATHS.payments).state };
}

async function runNativePayment({ spec, t, onEvent, keepRetaining }) {
  const { nativePaymentWorld } = await import('./native-payment-wire-fixture.mjs');
  const w = await nativePaymentWorld(t, { directories: spec.directories, retained: spec.retained && deserialize(Buffer.from(spec.retained, 'base64')), onEvent });
  keepRetaining(w.retain);
  if (spec.retained === null) {
    const p = await w.purchase(), txHash = p.pay();
    onEvent('job', { jobId: p.jobId, txHash });
    await p.claim(txHash);
    return {};
  }
  const p = await w.purchase({ resume: spec.job.jobId });
  const workRetained = (await w.work(p)) !== undefined;
  const answer = await p.claim(spec.job.txHash);
  return { delivered: answer.status, workRetained, answer };
}

async function runChild(specFile) {
  const spec = JSON.parse(readFileSync(specFile, 'utf8')), cleanups = [], t = { after: (cleanup) => cleanups.push(cleanup) };
  const { onEvent, keepRetaining } = childEvents(spec);
  try {
    const run = spec.world === 'fixture' ? runFixturePayment : runNativePayment;
    process.stdout.write(`${JSON.stringify(await run({ spec, t, onEvent, keepRetaining }))}\n`);
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await runChild(process.argv[2]); } catch (error) { console.error(error); process.exitCode = 1; }
  process.exit();
}

// ---- The parent ----

let childCount = 0;
// Runs one child to its end and returns how it ended with what it printed. The child is killed if it is still running when this returns.
async function runToEnd(root, spec) {
  const specFile = join(root, `child-${++childCount}.json`);
  writeFileSync(specFile, JSON.stringify(spec));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), specFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const deadline = setTimeout(() => child.kill('SIGKILL'), CHILD_DEADLINE_MS);
  try {
    const [code, signal] = await once(child, 'close');
    return { code, signal, stdout, stderr };
  } finally {
    clearTimeout(deadline);
    child.kill('SIGKILL');
  }
}

const readTape = (tape) => (existsSync(tape) ? readFileSync(tape, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
// The permits the seller has granted, each with the authorization it selected.
const readGrants = (file) => (existsSync(file) ? Object.fromEntries(Object.entries(JSON.parse(readFileSync(file, 'utf8')).records).map(([id, record]) => [id, record.selected])) : {});

/**
 * Runs a payment in `world` ('fixture' or 'native') in a child that kills itself at `killAt`, then recovers it in a new child over the same
 * directories. Returns `killed` (`signal`, and `at`, the point the child reported before it died), `reopened` (what the second child
 * printed: `delivered` (the answer's status text), `answer`, `workRetained` (whether it found the payment work saved) and, in the fixture
 * world, `attempt` (the wire journal's state of the payment request)), `grants` (the permits granted when
 * the first child died and at the end), `writes` (the count of each artifact written by both children together), and, for the native world,
 * `signedCreates` and `broadcastCreates` (the hash of each exact CREATE the wallet signed, and of each the node received) and
 * `signedBeforeKill` (how many CREATEs the first child had signed when it died).
 * Throws if the first child was not killed at `killAt` or the second did not finish; the directories are removed when the test ends.
 */
export async function killAndReopen(t, { world, killAt }) {
  if (!KILL_POINTS.includes(killAt)) throw new RangeError(`unknown kill point ${killAt}`);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-payment-restart-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directories = Object.fromEntries(DIRECTORY_NAMES[world].map((name) => [name, join(root, name)]));
  for (const directory of Object.values(directories)) mkdirSync(directory, { mode: 0o700 });
  const tape = join(root, 'events.jsonl'), grantsFile = join(directories[RECEIPTS_FILE[world][0]], ...RECEIPTS_FILE[world].slice(1));
  const first = await runToEnd(root, { world, directories, tape, killAt, retained: null, job: null });
  const before = readTape(tape), killedAt = before.find((event) => event.name === 'killed')?.at ?? null;
  const retained = before.findLast((event) => event.name === 'retained')?.dump ?? null;
  if (killedAt !== killAt || retained === null) throw new Error(`the seller process was not killed at ${killAt} (${first.code ?? first.signal}): ${first.stderr}`);
  const atKill = readGrants(grantsFile);
  const second = await runToEnd(root, { world, directories, tape, killAt: null, retained, job: before.find((event) => event.name === 'job') ?? null });
  if (second.code !== 0) throw new Error(`the reopened seller process failed (${second.code ?? second.signal}): ${second.stderr}`);
  const events = readTape(tape), writesAt = (role) => events.filter((event) => event.name === 'write' && event.role === role).length;
  return { killed: { signal: first.signal, at: killedAt }, reopened: JSON.parse(second.stdout.trim().split('\n').at(-1)), grants: { atKill, final: readGrants(grantsFile) },
    writes: Object.fromEntries(WRITE_ROLES.map(([, role]) => [role, writesAt(role)])),
    signedCreates: events.filter((event) => event.name === 'walletSigned').map((event) => event.bytesHash),
    signedBeforeKill: before.filter((event) => event.name === 'walletSigned').length,
    broadcastCreates: events.filter((event) => event.name === 'write' && event.role === 'evidenceCreates' && event.bytesHash).map((event) => event.bytesHash) };
}
