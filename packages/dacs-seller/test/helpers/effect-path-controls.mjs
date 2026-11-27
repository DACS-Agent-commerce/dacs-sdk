// The seller effect-path controls that the effect-path tests and the KILL tests both run: the Listing publisher over a stopping anchor,
// the inventory of signing paths, the passes whose final checks can be paused, and the composed host's pause-and-resume subcases.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TP1_APPROVED_IDENTITY_RECORD, WireError, bindTp1Profile } from '@kynesyslabs/dacs/wire';
import { T0, evidenceInput, sellerWalletWorld, spyTransactionSignatures } from './seller-node-wallet-world.mjs';
import { journalOverPass } from './payment-evidence-test-journals.mjs';

// Static imports are all resolved before any module runs, so a module that reaches the client's admission state is imported after the
// world helper above has installed the purchase-admission hook.
const { PATHS } = await import('./wire-routes-world.mjs');
const { TEST_BINDING, readOnlyRoleOf, testEffectBoundary, testRunCreate } = await import('./agent-signing.mjs');
const { createAnswerSigners } = await import('../../src/dacs/answer-signers.mjs');
const { createStopCheck } = await import('../../src/kill-switch.mjs');
const { orchestratorFixture } = await import('./vet-orchestrator-fixture.mjs');
const { productionFixture } = await import('./vet-production-fixture.mjs');
const { JOB: protocolJob, seller: protocolSeller } = await import('./protocol-fixture.mjs');
const { composedVetHost, composedVetHostProcess, vetRecordAnchor } = await import('./composed-vet-host.mjs');
const { default: Database } = await import('better-sqlite3');
const { authorityReader, TEST_CONNECTION } = await import('./wire-authority-fixture.mjs');
const { createDevnetDemoListingPublisher } = await import('../../src/devnet-demo/listing.mjs');
const { fixtureListing } = await import('../fixtures/listings.mjs');

export const JOB_ID = '01M5YKPJG0248H248H248H248H';
export const railAuthority = () => ({ trustPhase: 'PA-1', trustPolicyAcceptsPA1: true, registry: { state: 'not-used', entries: [], definitions: [] },
  inCodeDefinitions: [{ railId: 'demos-native:DEM', railVersion: 1, phaseHandler: 'pay-dem', governanceAnchoring: 'in-code', signatureValid: true }] });
// The job lanes' publish inputs; the guard and the parameter check refuse before the artifact is read.
export const LISTING_WALLET = Object.freeze({ claim: protocolSeller.claim, signBytes: protocolSeller.signBytes });
export const PUBLISHED = 'TEST_published';
export const codesOf = (error) => { const codes = []; for (let link = error; link; link = link.cause ?? link.errors?.[0]) codes.push(link.code); return codes; };
export const settled = (promise) => promise.then((value) => ({ value }), (error) => ({ error, codes: codesOf(error) }));

// An authorized ensureEvidence of `journal` for `input`.
export const evidenceAt = (journal, input, authorize = () => true) => journal.ensureEvidence({ ...input, expectedJournalId: journal.journalId, authorize });
export const executeCounts = (node) => Object.fromEntries(['confirmTx', 'broadcastTx'].map((stage) => [stage, node.reads.filter((read) => read === stage).length]));

// A Listing publisher over `runCreate` whose anchor ends each publication at publish, after its signature; `sign` is the wallet's.
export function stoppingListing(runCreate, { now = T0, sign = (bytes) => LISTING_WALLET.signBytes(bytes) } = {}) {
  const counts = { signs: 0, publishes: 0, signed: [] };
  const anchor = { publish: async () => { counts.publishes++; throw Object.assign(new Error('TEST the publication ends at publish'), { code: PUBLISHED }); },
    read: async () => ({ status: 'absent' }), verifyReceipt: async () => 'invalid' };
  const publish = createDevnetDemoListingPublisher({ anchor, runCreate, scanOwnListings: async () => ({ status: 'ok', anchors: [] }), loadRailResolution: railAuthority,
    sign: async (bytes, options) => { counts.signs++; counts.signed.push(Buffer.from(bytes)); return sign(bytes, options); } });
  const draft = fixtureListing(LISTING_WALLET, { now });
  delete draft.signature;
  return { publish, draft, counts };
}

export const EFFECT_ANSWER = Object.freeze({ request: { path: PATHS.proposals, jobId: JOB_ID }, status: 200, text: '{"disposition":"complete"}' });

// Each seller inventory path of this composition over `pass` (`{ runCreate, effectBoundary, binding }`): `attempt()` runs the path once,
// `signatures()` counts its cryptographic signer calls and `transmissions()` its wallet requests or POSTs.
export async function inventory(t, pass) {
  const listing = stoppingListing(pass.runCreate);
  const vet = await orchestratorFixture(t);
  const provider = vet.provider({ runCreate: pass.runCreate });
  const presentation = productionFixture();
  t.after(() => presentation.base.close());
  presentation.config.runCreate = pass.runCreate;
  const answerSigns = { count: 0 };
  const roles = { claim: protocolSeller.claim, sign: (bytes) => { answerSigns.count++; return protocolSeller.signBytes(bytes); }, readOnlyAnswerSigner: readOnlyRoleOf(protocolSeller) };
  const answers = createAnswerSigners({ roles, effectBoundary: pass.effectBoundary, binding: pass.binding, local: () => ({ ...TEST_CONNECTION }) });
  return [
    { label: 'the Listing publication', attempt: () => settled(listing.publish(listing.draft)), signatures: () => listing.counts.signs, transmissions: () => listing.counts.publishes },
    { label: 'the Vet component signatures through the provider\'s resolveBuyer', attempt: () => settled(provider.resolveBuyer(vet.input, { writable: () => true })),
      signatures: () => vet.controls.signatures.length, transmissions: () => vet.controls.creates.length },
    { label: 'the identity presentation', attempt: () => settled(presentation.run()), signatures: () => presentation.controls.signs, transmissions: () => presentation.local.writes.length },
    { label: 'an effect-route answer', attempt: () => settled(answers.signAnswer(EFFECT_ANSWER, (signer) => signer.sign(Buffer.from('TEST-answer')))), signatures: () => answerSigns.count, transmissions: () => 0 },
  ];
}
// A data directory that holds a KILL entry, removed when the test ends.
export const killedDirectory = (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'TEST-killed-'));
  writeFileSync(join(directory, 'KILL'), '');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
export const passOver = ({ binding = TEST_BINDING, stopped = () => false } = {}) => {
  const { effectBoundary } = testEffectBoundary({ binding, stopped });
  return { effectBoundary, binding, runCreate: testRunCreate({ effectBoundary, stopped }).runCreate };
};

// The payment-evidence entries under a real KILL file: each call's approval is real and given before KILL appears, then the journal's
// ensureEvidence, the pass's signCreate and its broadcast refuse seller_stopped, and nothing is signed, confirmed or broadcast.
export async function paymentEvidenceUnderKill(t) {
  const signatures = await spyTransactionSignatures(t.mock), signal = new AbortController().signal, authorize = () => true;
  const refusedStopped = async (entry, run) => {
    const outcome = await settled(run());
    assert.ok(outcome.codes?.includes('seller_stopped'), `${entry}: refused seller_stopped under KILL, got ${outcome.codes}`);
  };
  const kill = (directory) => writeFileSync(join(directory, 'KILL'), '');
  // The journal, and the pass's signCreate with an approval given before KILL.
  {
    const directory = mkdtempSync(join(tmpdir(), 'TEST-evidence-kill-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const world = await sellerWalletWorld(t), input = evidenceInput(world);
    const { journal, pass } = journalOverPass(world, { stopped: createStopCheck(directory) });
    const approval = (await pass.approveAhead(input, { signal, authorize })).approval;
    kill(directory);
    await refusedStopped('paymentEvidence.signCreate', () => pass.signCreate(input, { signal, approval, authorize }));
    await refusedStopped('ensureEvidence', () => evidenceAt(journal, input));
    assert.deepEqual({ signatures: signatures.length, ...executeCounts(world.node) }, { signatures: 0, confirmTx: 0, broadcastTx: 0 }, 'under KILL nothing is signed, confirmed or broadcast');
    await world.wallet.close();
  }
  // The pass's broadcast of a CREATE signed before KILL, with its send approval given before KILL: held, never sent.
  {
    const directory = mkdtempSync(join(tmpdir(), 'TEST-evidence-kill-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const world = await sellerWalletWorld(t), input = evidenceInput(world), before = signatures.length;
    const { pass } = journalOverPass(world, { stopped: createStopCheck(directory) });
    const signed = await pass.signCreate(input, { signal, approval: (await pass.approveAhead(input, { signal, authorize })).approval, authorize });
    const retained = { signedTransaction: signed.signedTransaction, txHash: signed.txHash };
    const approval = (await pass.approveSendAhead(retained, { signal, authorize })).approval;
    kill(directory);
    await refusedStopped('paymentEvidence.broadcast', () => pass.broadcast(retained, { signal, approval, authorize, jobId: input.jobId }));
    assert.deepEqual({ signatures: signatures.length - before, ...executeCounts(world.node) }, { signatures: 1, confirmTx: 0, broadcastTx: 0 }, 'the CREATE signed before KILL was not confirmed or broadcast');
    await world.wallet.close();
  }
}

// A pass whose authority reads and stop checks can each be paused at a chosen call: `gate.pause('authority' | 'stop', at)` holds that
// call until `gate.resume()`; `gate.closed` makes the authority refuse and `gate.stopNow()` makes the stop check answer true, by the
// in-process flag or, with `stopSeam` 'a KILL file', by a KILL entry in a private data directory read by the kit's stop check.
async function pausablePass(t, stopSeam = 'the stop flag') {
  const killed = stopSeam === 'a KILL file' ? mkdtempSync(join(tmpdir(), 'TEST-paused-kill-')) : null;
  if (killed !== null) t.after(() => rmSync(killed, { recursive: true, force: true }));
  const killCheck = killed === null ? () => false : createStopCheck(killed);
  const reader = authorityReader();
  const gate = { calls: { authority: 0, stop: 0 }, at: null, held: null, closed: false, stop: false,
    pause(kind, at) { this.calls = { authority: 0, stop: 0 }; this.at = { kind, at }; },
    stopNow() { if (killed === null) this.stop = true; else writeFileSync(join(killed, 'KILL'), ''); },
    resume() { const held = this.held; this.held = null; held?.(); } };
  const hold = async (kind) => { gate.calls[kind] += 1; if (gate.at?.kind === kind && gate.at.at === gate.calls[kind]) await new Promise((resume) => { gate.held = resume; }); };
  const readAuthority = async (scope) => {
    await hold('authority');
    if (gate.closed) throw new WireError('tp1_participant_refused', 503, undefined, new Error('TEST authority closed'));
    return reader(scope);
  };
  const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: { ...TEST_CONNECTION }, readAuthority });
  const stopped = async () => { await hold('stop'); return gate.stop || killCheck(); };
  const { effectBoundary } = testEffectBoundary({ binding, stopped });
  return { gate, binding, effectBoundary, runCreate: testRunCreate({ effectBoundary }).runCreate };
}

// The paths whose final checks are paused outside the composed host: each `make(pass)` gives `{ attempt(), signatures(), onSign(hook), restart? }`.
// The presentation runs over the production Vet fixture, the Listing over the isolated anchor with an issued runCreate, and the answer
// signer over a boundary whose stop check can be paused (the host's own stop check is not held).
const PAUSED_PATHS = [
  ['the identity presentation', async (t, pass) => {
    const p = productionFixture();
    t.after(() => p.base.close());
    p.config.runCreate = pass.runCreate;
    const signBytes = p.config.wallet.signBytes;
    let hook = null;
    p.config.wallet.signBytes = (bytes, request) => { if (Buffer.from(bytes).toString().startsWith('dacs-bundle-presentation:v1:')) hook?.(bytes); return signBytes(bytes, request); };
    return { attempt: () => settled(p.run()), signatures: () => p.controls.presentationSigns, onSign: (next) => { hook = next; } };
  }],
  ['the Listing signature', async (t, pass) => {
    let hook = null;
    const listing = stoppingListing(pass.runCreate, { sign: (bytes) => { hook?.(bytes); return LISTING_WALLET.signBytes(bytes); } });
    return { attempt: () => settled(listing.publish(listing.draft)), signatures: () => listing.counts.signs, onSign: (next) => { hook = next; },
      restart: () => settled(listing.publish(listing.draft)) };
  }],
  ['an effect-route answer', async (t, pass) => {
    let hook = null, count = 0;
    const roles = { claim: protocolSeller.claim, sign: (bytes) => { count++; hook?.(bytes); return protocolSeller.signBytes(bytes); }, readOnlyAnswerSigner: readOnlyRoleOf(protocolSeller) };
    const answers = createAnswerSigners({ roles, effectBoundary: pass.effectBoundary, binding: pass.binding, local: () => ({ ...TEST_CONNECTION }) });
    return { attempt: () => settled(answers.signAnswer(EFFECT_ANSWER, (signer) => signer.sign(Buffer.from('TEST-answer')))), signatures: () => count, onSign: (next) => { hook = next; } };
  }],
];

// The composed host's context admission row for `jobId`: `contextRow` reads its state, `moveContextRow` rewrites its record as another
// writer of the store would (a reclaimed attempt, or a compensation that advances its revision).
const HOST_JOB = protocolJob, NEXT_HOST_JOB = '01J8N4YV7YVYQ4DB7M8T4C7W0B';
const transportStore = (directory, options) => new Database(join(directory, 'transport', 'transport.sqlite'), options);
const contextRow = (directory, jobId = HOST_JOB) => {
  const db = transportStore(directory, { readonly: true });
  try { return db.prepare('SELECT state FROM kit_context_admissions WHERE jobId = ?').get(jobId)?.state ?? null; } finally { db.close(); }
};
const moveContextRow = (directory, change, jobId = HOST_JOB) => {
  const db = transportStore(directory);
  try {
    const next = change(JSON.parse(db.prepare('SELECT record FROM kit_context_admissions WHERE jobId = ?').get(jobId).record));
    db.prepare('UPDATE kit_context_admissions SET state = ?, rev = ?, record = ? WHERE jobId = ?').run(next.state, next.rev, JSON.stringify(next), jobId);
  } finally { db.close(); }
};
// Resolves once `gate` holds a call, and fails when the request ends first.
const heldBefore = async (gate, request, name) => {
  let ended = false;
  void request.then(() => { ended = true; }, () => { ended = true; });
  while (gate.held === null && !ended) await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(gate.held, null, `${name}: paused at its final await`);
};

// The final pause-and-resume subcases. `stopSeam` is how a stop turns true: 'the stop flag' (the gates' in-process flag) or 'a KILL file'
// (a KILL entry in the data directory the kit's stop check reads, the seam the host itself uses); with a KILL file only the stop awaits run.
export async function finalPauseSubcases(t, stopSeam) {
  const withKill = stopSeam === 'a KILL file';
  const killPath = (w) => join(w.dataDirectory, 'KILL');
  const stopNow = (w) => { if (withKill) writeFileSync(killPath(w), ''); else w.gate.stop = true; };
  // The composed host over the real Vet provider, its buyer through the real challenge and context routes. The control finds the final
  // authority read and final stop check of the first Vet component signature's pass, and the final authority read of the context answer's.
  const control = await composedVetHost(t), started = await control.start(), finals = { vet: null, answer: null };
  control.gate.pause('none', 0);
  control.hooks.onSign = () => { finals.vet ??= { ...control.gate.calls }; };
  control.hooks.onEffect = () => { if (control.signatures.length === 2) finals.answer ??= { ...control.gate.calls }; };
  const answered = await started.buyer.requestContext();
  assert.deepEqual([answered.status, control.signatures.length], [200, 2], `the control signs both Vet records and answers: ${answered.text}`);
  assert.ok(finals.vet.authority >= 1 && finals.vet.stop >= 1 && finals.answer.authority > finals.vet.authority, 'the control reached each signer after its checks');

  for (const kind of withKill ? ['stop'] : ['authority', 'stop']) {
    const subcases = [
      ['the unchanged authorized control', null, null],
      ['closure', (w) => { if (kind === 'authority') w.gate.closed = true; else stopNow(w); }, kind === 'authority' ? 'tp1_participant_refused' : 'seller_stopped'],
      ['issuance and reclamation', (w) => moveContextRow(w.dataDirectory, (row) => ({ ...row, attempt: row.attempt + 1 })), 'not-pending'],
      ['rollback', (w) => moveContextRow(w.dataDirectory, (row) => ({ ...row, state: 'compensating', rev: row.rev + 1 })), 'not-pending'],
    ];
    for (const [subcase, change, code] of subcases) {
      const name = `the Vet component signature through the composed host, final ${kind} await, ${subcase}`;
      const w = await composedVetHost(t), { buyer } = await w.start();
      w.gate.pause(kind, finals.vet[kind]);
      const request = buyer.requestContext();
      await heldBefore(w.gate, request, name);
      change?.(w);
      w.gate.resume();
      const answer = await request;
      if (change === null) {
        assert.deepEqual([answer.status, w.signatures.length], [200, 2], `${name}: signs both Vet records and answers`);
        continue;
      }
      // A closed authority grants no signature at all: the read-only role checks it too, so that refusal goes out unsigned.
      const signedRefusal = !(subcase === 'closure' && kind === 'authority');
      assert.deepEqual([answer.status >= 400, answer.signed, w.signatures.length], [true, signedRefusal, 0], `${name}: a refusal and no signature: ${answer.text}`);
      assert.ok((await w.failedSteps()).includes(code), `${name}: the Vet step keeps ${code}, got ${await w.failedSteps()}`);
    }

    // Restart: the host process is killed at the final await; the host started again over its data directory and party Vet store fences the
    // attempt at its startup sweep and signs nothing for it, and the next purchase signs each Vet record once.
    const name = `the Vet component signature through the composed host, final ${kind} await, restart`;
    const anchor = vetRecordAnchor(), w = await composedVetHost(t, { anchor });
    await (await w.start()).host.close();
    const killed = await composedVetHostProcess(t, { dataDirectory: w.dataDirectory, vetPath: w.vetPath, anchor, kind, at: finals.vet[kind] });
    const ended = (await w.buyerFor(killed.host)).requestContext().then(() => null, (error) => error);
    await killed.held;
    await killed.kill();
    assert.ok((await ended) instanceof Error, `${name}: the killed host sends no answer`);
    assert.deepEqual([killed.signatures(), anchor.records.size, contextRow(w.dataDirectory)], [0, 0, 'running'], `${name}: the killed host signed and published nothing`);
    // A host restarted while KILL remains leaves the attempt as it was and signs nothing; the next restart without KILL fences it.
    if (withKill) writeFileSync(killPath(w), '');
    let restarted = await w.start();
    if (withKill) {
      assert.deepEqual([contextRow(w.dataDirectory), w.signatures.length], ['running', 0], `${name}: with KILL present the restarted host leaves the attempt and signs nothing`);
      await restarted.host.close();
      rmSync(killPath(w));
      restarted = await w.start();
    }
    const { buyer } = restarted;
    assert.deepEqual([contextRow(w.dataDirectory), w.signatures.length], ['compensating', 0], `${name}: the restarted host fences the attempt and signs nothing for it`);
    const next = await buyer.requestContext(NEXT_HOST_JOB);
    assert.deepEqual([next.status, w.signatures.length, new Set(w.signatures).size], [200, 2, 2], `${name}: the next purchase signs each Vet record once`);
  }

  // The context answer's own effect pass in the composed host, paused at its final authority read: the control answers with the effect
  // role's signature; closed there, the answer is an unsigned refusal carrying the cause, and nothing signs it.
  for (const [subcase, closed] of withKill ? [] : [['the unchanged authorized control', false], ['closure', true]]) {
    const name = `the context answer through the composed host, final authority await, ${subcase}`;
    const w = await composedVetHost(t), { buyer } = await w.start();
    w.gate.pause('authority', finals.answer.authority);
    const request = buyer.requestContext();
    await heldBefore(w.gate, request, name);
    const effectBefore = w.effectSigns();
    w.gate.closed = closed;
    w.gate.resume();
    const answer = await request;
    if (!closed) {
      assert.deepEqual([answer.status, w.effectSigns() - effectBefore], [200, 1], `${name}: the effect role signs the answer`);
      continue;
    }
    assert.deepEqual([answer.status >= 400, answer.signed, answer.body.error, w.effectSigns() - effectBefore], [true, false, 'tp1_participant_refused', 0], `${name}: ${answer.text}`);
  }

  // The paths that run outside the composed host (see PAUSED_PATHS).
  for (const [label, make] of PAUSED_PATHS) {
    // The control finds where the final authority read and stop check of the first signature's pass are: the last of each before the signer.
    const probe = await pausablePass(t, stopSeam), probed = await make(t, probe);
    let finals = null;
    probe.gate.pause('none', 0);
    probed.onSign(() => { finals ??= { ...probe.gate.calls }; });
    await probed.attempt();
    assert.ok(finals !== null && finals.authority >= 1 && finals.stop >= 1, `${label}: the control reached its signer after its checks`);
    for (const kind of withKill ? ['stop'] : ['authority', 'stop']) {
      const subcases = [
        ['the unchanged authorized control', null, null],
        ['closure', (target, gate) => { if (kind === 'authority') gate.closed = true; else gate.stopNow(); }, kind === 'authority' ? 'tp1_participant_refused' : 'seller_stopped'],
        ['issuance and reclamation', 'reclaim', 'not-pending'],
        ['rollback', 'rollback', 'not-pending'],
        ['restart', 'restart', null],
      ];
      for (const [subcase, change, code] of subcases) {
        const pass = await pausablePass(t, stopSeam), target = await make(t, pass);
        if (typeof change === 'string' && target[change] === undefined) continue;
        pass.gate.pause(kind, finals[kind]);
        const outcome = target.attempt();
        for (let turn = 0; turn < 500 && pass.gate.held === null; turn++) await new Promise((resolve) => setImmediate(resolve));
        assert.notEqual(pass.gate.held, null, `${label}, ${kind}, ${subcase}: paused at the final ${kind} await`);
        const name = `${label}, final ${kind} await, ${subcase}`;
        if (subcase === 'restart') {
          // The paused process dies there; a new process over the same durable state signs the same signature at most once.
          const restarted = await target.restart();
          const signedAfterRestart = target.signatures();
          pass.gate.stopNow();
          pass.gate.resume();
          await outcome;
          assert.ok(signedAfterRestart <= 1 && target.signatures() === signedAfterRestart, `${name}: no second signature (${signedAfterRestart}, ${restarted.codes ?? 'answered'})`);
          continue;
        }
        if (typeof change === 'string') target[change](); else change?.(target, pass.gate);
        pass.gate.resume();
        const result = await outcome;
        if (change === null) {
          assert.ok(target.signatures() >= 1, `${name}: signs`);
          continue;
        }
        assert.equal(target.signatures(), 0, `${name}: no signature`);
        assert.ok(result.codes?.includes(code) || JSON.stringify(result.value ?? {}).includes(code), `${name}: refused ${code}, got ${result.codes} ${JSON.stringify(result.value)}`);
      }
    }
  }
}
