// The client's effect boundary over the actor fence and the dispatch history.
// An operation has one effect per lane: the artifact it signed first. Every
// signature, release and send of it passes the same checks under the fence,
// and is recorded in the history before it leaves. Internal: not exported by
// the package.
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { assertTp1Binding } from '@kynesyslabs/dacs/wire';
import { OperationError } from '../client-errors.mjs';
import { assertPurchaseActionsAdmitted } from '../dacs/action-admission.mjs';
import { AUTHORITY_READ_DEADLINE_MS } from '../public-admission.mjs';

const UINT = /^(0|[1-9][0-9]*)$/;
const OPERATION_KINDS = new Set(['native', 'confirm', 'create', 'wire', 'signature']);
const REPLAYABLE_KINDS = new Set(['create', 'wire']);
// An effect stage has its own records: `<stage>-started`, `-withheld`, `-acknowledged` and
// `-unknown`. `dispatch` is the one that sends the artifact; `confirm` asks the node to
// check it first and never counts as a possible dispatch. The recovery stages do the same
// for an artifact that was already sent and is being recovered.
const STAGES = ['dispatch', 'confirm', 'recovery-confirm', 'recovery-dispatch'];
const STAGE_RECORDS = ['started', 'withheld', 'acknowledged', 'unknown'];
const HISTORY_STATES = new Set(['signed', 'signed-held', 'observed', ...STAGES.flatMap((stage) => STAGE_RECORDS.map((record) => `${stage}-${record}`))]);
const STAGE_ANSWER_NOT_ACCEPTED = 'stage_answer_not_accepted';
const OPERATION_FIELDS = ['operationId', 'lane', 'kind', 'paidWrite', 'debitOs', 'approvalRef', 'k1Rev', 'pinVersion'];
const FIRST_PASS = 'p1';
const systemClock = { now: () => performance.now(), setTimer: setTimeout, clearTimer: clearTimeout };

const refusal = (code, cause, details) => new OperationError(code, `effect refused: ${code}`, details, cause === undefined ? undefined : { cause });
const isDecimal = (value) => typeof value === 'string' && UINT.test(value);
const isThenable = (value) => typeof value?.then === 'function';
const stageOf = (state) => STAGES.find((stage) => state.startsWith(`${stage}-`));
// The stages whose records can mean the artifact reached the node. A recovery stage starts from an
// artifact that was sent, so only recovery's own send counts there.
const sendingStages = (stage) => (stage.startsWith('recovery-') ? ['recovery-dispatch'] : ['dispatch', 'recovery-dispatch']);
const passKey = (state, passId) => `${stageOf(state)}:${passId}`;
const failureCode = (cause) => ({ code: typeof cause?.code === 'string' ? cause.code : 'effect_failed' });
// The operation as the fee check reads it: the whole debit of the confirmed transaction replaces the declared one when the caller has it.
const feeView = (operation, confirmedDebitOs) => (confirmedDebitOs === undefined ? operation : { ...operation, debitOs: confirmedDebitOs });
const operationMetadata = (record) => Object.fromEntries(OPERATION_FIELDS.filter((field) => record[field] !== undefined).map((field) => [field, record[field]]));

// A private copy of the operation as it is authorized and retained: later changes by the caller change nothing.
function snapshotOperation(operation) {
  if (!operation || typeof operation.operationId !== 'string' || !operation.operationId || typeof operation.lane !== 'string' || !operation.lane
    || !OPERATION_KINDS.has(operation.kind) || typeof operation.paidWrite !== 'boolean') throw new TypeError('an effect operation needs operationId, lane, kind and paidWrite');
  const artifact = operation.artifactHash === undefined ? {} : { artifactHash: operation.artifactHash };
  return structuredClone({ ...operationMetadata(operation), ...artifact });
}

function requireSources({ binding, currentLocal, stopped, history, fence, clock }) {
  if (!binding || typeof binding !== 'object') throw new TypeError('the effect boundary needs a binding');
  if (typeof currentLocal !== 'function') throw new TypeError('the effect boundary needs currentLocal');
  if (typeof stopped !== 'function') throw new TypeError('the effect boundary needs stopped');
  if (typeof history?.append !== 'function' || typeof history?.readOperation !== 'function') throw new TypeError('the effect boundary needs a dispatch history');
  if (typeof fence?.withFence !== 'function' || typeof fence?.replaceConnection !== 'function') throw new TypeError('the effect boundary needs an actor fence');
  if (!['now', 'setTimer', 'clearTimer'].every((name) => typeof clock?.[name] === 'function')) throw new TypeError('the effect boundary needs now, setTimer and clearTimer');
}

// One pass's authority reads and stop checks share AUTHORITY_READ_DEADLINE_MS of read
// time (waiting for the fence has its own deadline). A read that does not finish inside
// what is left refuses with its timeout code, aborts the `signal` its task is given, and
// a result that arrives later is ignored.
function createReadBudget(clock) {
  let remainingMs = AUTHORITY_READ_DEADLINE_MS;
  return async function read(task, timeoutCode) {
    if (remainingMs <= 0) throw refusal(timeoutCode);
    const startedAt = clock.now();
    let timer;
    const controller = new AbortController();
    const timeout = () => { const error = refusal(timeoutCode); controller.abort(error); return error; };
    try {
      const expired = new Promise((_resolve, reject) => { timer = clock.setTimer(() => reject(timeout()), remainingMs); });
      const result = await Promise.race([new Promise((resolve) => resolve(task({ signal: controller.signal }))), expired]);
      if (clock.now() - startedAt >= remainingMs) throw timeout();
      return result;
    } finally {
      clock.clearTimer(timer);
      remainingMs -= clock.now() - startedAt;
    }
  };
}

// The one state of an operation's effect on its lane, from all its records in commit
// order. Possible dispatch outranks held, which outranks signed; anything missing,
// unknown or inconsistent is never evidence that nothing was sent. A dispatch reuses the
// latest signed pass while no other record names it, and otherwise starts pass p<n>
// with a fresh signed record, so two passes that read the same records collide on one
// key and only one of them proceeds. A stage's own withheld records hold that stage; a
// possible dispatch is only the dispatch stage's, so a confirm stage that is unknown or
// never finished never blocks a new confirm pass or the dispatch.
function operationState(records, operation, pinVersion, stage) {
  if (records.length === 0) return { state: 'none' };
  const started = new Set(), withheld = new Set(), signedRecords = [], sending = sendingStages(stage);
  let held = false, possible = false;
  for (const record of records) {
    if (record.pinVersion !== pinVersion) throw refusal('pin_version_retired');
    if (!HISTORY_STATES.has(record.state) || record.artifactHash !== operation.artifactHash
      || canonicalize(operationMetadata(record)) !== canonicalize(operationMetadata(operation))) throw refusal('eb_history_unavailable');
    if (record.state === 'signed') {
      const bytes = typeof record.bytes === 'string' ? Buffer.from(record.bytes, 'base64') : null;
      if (!bytes || bytes.toString('base64') !== record.bytes || sha256Hex(bytes) !== record.artifactHash) throw refusal('eb_history_unavailable');
      signedRecords.push(record);
    } else if (signedRecords.length === 0) throw refusal('eb_history_unavailable');
    if (record.state === 'signed-held' || record.state === `${stage}-withheld`) held = true;
    if (record.state.endsWith('-started')) started.add(passKey(record.state, record.passId));
    if (record.state.endsWith('-withheld')) {
      if (!started.has(passKey(record.state, record.passId))) throw refusal('eb_history_unavailable');
      withheld.add(passKey(record.state, record.passId));
    }
    if (record.state === 'observed' || (sending.includes(stageOf(record.state)) && /-(unknown|acknowledged)$/.test(record.state))) possible = true;
  }
  const signed = signedRecords.at(-1);
  const open = records.every((record) => record === signed || record.passId !== signed.passId);
  possible ||= [...started].some((key) => sending.some((sender) => key.startsWith(`${sender}:`)) && !withheld.has(key));
  return { state: possible ? 'possible' : held ? 'held' : 'signed', signed, passId: open ? signed.passId : `p${signedRecords.length + 1}`, fresh: !open };
}

// Runs the tasks of one key one after another, in call order; a task that fails does
// not stop the next. An idle key keeps no entry.
function createKeyedQueue() {
  const tails = new Map();
  return function enqueue(key, task) {
    const result = (tails.get(key) ?? Promise.resolve()).then(task);
    const tail = result.then(() => {}, () => {});
    tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return result;
  };
}

/**
 * Builds the client's effect boundary. Required host sources, each a TypeError when
 * missing: `binding` (from bindTp1Profile), `currentLocal()`, `stopped()` (called with no
 * arguments; returns a boolean or a promise), the dispatch `history` and the actor `fence`. `feeCeilingOs` (decimal OS,
 * no default) is needed by a paid write and refuses `fee_ceiling_required` without it.
 * `clock` is `{ now, setTimer, clearTimer }`, monotonic by default. An operation
 * carrying an `approvalRef` `{ rev }` needs a synchronous `currentApproval(approvalRef)`
 * that returns `{ rev, open }`; one carrying `k1Rev` needs a synchronous
 * `currentRevision(operationId)`. `replayPolicy(operation, records)` (synchronous,
 * `true` to allow) is the only way a CREATE or wire artifact with a possible dispatch
 * is replayed; a native or confirm artifact never is.
 *
 * An operation is `{ operationId, lane, kind, paidWrite, debitOs?, approvalRef?, k1Rev?,
 * pinVersion }`. Right before each effect (calling `sign()`, handing out a signature or
 * an artifact, calling `send()`) the boundary re-reads admission, the stop seam, the fee
 * and approval, the binding and the stop seam again, then checks admission, fee,
 * connection and revision with no await before the effect. Pass entry points reject with
 * the signer's, transport's or authority reader's own error, or an OperationError
 * carrying a refusal code, and always releases the fence it acquired. When the work
 * succeeded but the fence release failed, the pass rejects `eb_fence_release_failed`
 * instead: the work's return value (a send's result, a signed artifact) is
 * `error.details.result` and the release failure is `error.cause`.
 *
 * - `signPass(operation, sign)`: refuses `eb_operation_signed` (with the recorded
 *   `artifactHash` in `details`) once the operation has a record on its lane, without
 *   calling `sign`. Calls `sign({ signal })` with a deadline of its own
 *   (AUTHORITY_READ_DEADLINE_MS, apart from the reads' budget); expiry aborts the
 *   signal and refuses `eb_sign_timeout`, ignoring late bytes. Resolves
 *   the artifact `{ ...operation, artifactHash }` after the signer's
 *   bytes are durable; a refusal after that leaves `signed-held`. Calls for one operation
 *   and lane that run together are queued: a later one is refused as above once the
 *   earlier one has recorded its artifact, and signs if the earlier one failed.
 * - `dispatchPass(artifact, send, { explicit, stage, material, confirmedDebitOs, authorize })`: passes the retained
 *   bytes to `send(bytes, final)` once, after recording `<stage>-started`; a refusal then records
 *   `<stage>-withheld`. `authorize()` (optional, synchronous) runs with the dispatch checks, before `send` is
 *   called, so what `send` writes before its own last check is never written for a send that is already refused.
 *   `stage` is `'dispatch'` (the default: the send itself), `'confirm'`
 *   (the node's check of the bytes before the send, never a possible dispatch), or the recovery
 *   stages `'recovery-confirm'` and `'recovery-dispatch'` (the same two for an artifact that was
 *   already sent: only a recovery send counts as a possible dispatch there); any other
 *   stage is a `TypeError`. A send that has awaits of its own before the transport call finishes
 *   them, then calls `final(check, effect)` and returns what it returns: `final` awaits the stop check,
 *   runs the admission, fee, connection and revision checks and `check()` synchronously, and calls
 *   `effect()` in that same run. A refusal there (nothing was transmitted) records `<stage>-withheld`
 *   with its cause, where any other failure of `send` records `<stage>-unknown`.
 *   `confirmedDebitOs` (decimal OS, or `null` for a debit that could not be read) replaces the
 *   artifact's own `debitOs` in the fee check only, so `null` refuses `write-fee-cap`; the records
 *   keep the artifact's own fields. After `send` returns, `material(result)` (optional, called once)
 *   gives the extra fields of `<stage>-acknowledged`, or `undefined` when the answer is not
 *   acceptable: the stage then records `<stage>-unknown` with cause
 *   `stage_answer_not_accepted` and resolves the answer all the same.
 *   A non-callable `send` rejects TypeError before reading or writing history.
 *   A held or withheld artifact needs `explicit: true`, which a composition sets only for
 *   a fresh request of its own; a possible dispatch refuses `eb_readback_required`; an
 *   artifact that is not the operation's one signed artifact refuses `eb_history_unavailable`.
 *   When `send` returned but the acknowledgement record could not be written, it rejects
 *   `eb_ack_not_persisted`: the artifact was sent, the send's return value is
 *   `error.details.result`, and the write failure is `error.cause`.
 * - `holdFence(operation)`: runs the checks before a pass, acquires the fence once, runs
 *   them again under it and resolves `{ run(work), release() }`. The fence stays held until
 *   `release()`, which resolves once it is let go (and rejects with the release failure).
 *   Passes made inside `run(work)` for the same operation id reuse the fence; another id is
 *   refused `tp1_fence_not_owned`. A refusal or a fence timeout rejects with its own code and
 *   holds nothing. Callers whose steps do not share one async context (the wallet's
 *   separate requests) hold the fence this way.
 * - `withOperation(operation, work)`: holds the fence across `work`; passes made inside
 *   for the same operation reuse it, another operation is refused `tp1_fence_not_owned`.
 *   Do not await `replaceConnection` inside it.
 * - `signerFor(operation, signer)`: a wire signer whose `sign` signs the operation once
 *   and releases the signature like a send: it is recorded as `dispatch-started`, so the
 *   artifact is never sent again by a later `dispatchPass`. Calls the underlying
 *   `signer.sign(bytes, { signal })` with the signing pass's abort signal.
 * - `replaceConnection(replace)`: the fence's connection replacement; rejects the
 *   fence's own release error if release fails after a successful replacement.
 */
export function createEffectBoundary({ binding, currentLocal, stopped, feeCeilingOs, history, fence, clock = systemClock, currentApproval, currentRevision, replayPolicy } = {}) {
  requireSources({ binding, currentLocal, stopped, history, fence, clock });
  const operations = new AsyncLocalStorage();
  // The history key of a signed record includes the artifact hash, so the store cannot
  // tell two different signatures of one operation apart. Signing is queued per
  // operation and lane: a later call reads the earlier one's record before it signs.
  const signingQueue = createKeyedQueue();

  async function checkStop(read) {
    let isStopped;
    try { isStopped = await read(() => stopped(), 'stop_check_timeout'); } catch (cause) {
      throw cause?.code === 'stop_check_timeout' ? cause : refusal('stop_check_failed', cause);
    }
    if (typeof isStopped !== 'boolean') throw refusal('stop_check_invalid');
    if (isStopped) throw refusal('writes_stopped');
  }

  function checkFee(operation) {
    if (operation.paidWrite) {
      if (!isDecimal(feeCeilingOs)) throw refusal('fee_ceiling_required');
      if (!isDecimal(operation.debitOs) || BigInt(operation.debitOs) > BigInt(feeCeilingOs)) throw refusal('write-fee-cap');
    }
    if (operation.approvalRef !== undefined) {
      const current = currentApproval?.(operation.approvalRef);
      if (isThenable(current) || current?.open !== true || current.rev !== operation.approvalRef.rev) throw refusal('write-fee-cap');
    }
  }

  async function checkBinding(read, operation) {
    // The wire's own `tp1_binding_required` comes first for a value that is no binding.
    if (binding.profile && operation.pinVersion !== binding.profile.pinVersion) throw refusal('pin_version_retired');
    await read(() => assertTp1Binding(binding, currentLocal()), 'tp1_authority_timeout');
  }

  function assertSameConnection(capability) {
    let digest;
    try { digest = sha256Hex(canonicalize(currentLocal())); } catch (cause) { throw refusal('tp1_local_binding_changed', cause); }
    if (digest !== binding.localDigest || digest !== capability.localDigest || fence.connectionGeneration !== capability.connectionGeneration) throw refusal('tp1_local_binding_changed');
  }

  // Admission, stop, fee and binding: refuse early. They authorize nothing on their own.
  async function precheck(read, operation) {
    assertPurchaseActionsAdmitted();
    await checkStop(read);
    checkFee(operation);
    await checkBinding(read, operation);
  }

  // The awaited half of the authorization before every effect: the reads, then a final
  // stop check after the final authority read. `gate` must follow it.
  async function refresh(read, operation) {
    await precheck(read, operation);
    await checkStop(read);
  }

  // The synchronous half, run right before the effect: nothing may await between the two.
  function gate(frame, operation) {
    assertPurchaseActionsAdmitted();
    checkFee(operation);
    assertSameConnection(frame.capability);
    if (operation.k1Rev !== undefined) {
      const revision = currentRevision?.(operation.operationId);
      if (revision === undefined || isThenable(revision) || revision !== operation.k1Rev) throw refusal('context_admission_closed');
    }
  }

  // One pass under the operation's fence capability, its own or the enclosing operation's.
  async function runPass(operation, work) {
    assertPurchaseActionsAdmitted();
    const read = createReadBudget(clock);
    const enclosing = operations.getStore();
    if (enclosing) {
      if (enclosing.operationId !== operation.operationId) throw refusal('tp1_fence_not_owned');
      const heldScope = enclosing.inFence;
      if (!heldScope) return fence.withFence(operation.operationId, () => work(enclosing, read), { capability: enclosing.capability });
      // A frame from holdFence: the fence accepts its capability only in the scope that
      // acquired it, so only the ownership check runs there. The work runs back in the
      // caller's own context, which keeps the caller's journal lock and other async-local
      // values. This means any pass made inside the held frame may use the fence's capability.
      const caller = new AsyncResource('dacs-held-pass');
      return heldScope.runInAsyncScope(() => fence.withFence(operation.operationId,
        () => caller.runInAsyncScope(() => work(enclosing, read)), { capability: enclosing.capability }));
    }
    await precheck(read, operation);
    let finished;
    try {
      return await fence.withFence(operation.operationId, async (capability) => {
        const frame = { operationId: operation.operationId, capability };
        const result = await operations.run(frame, () => work(frame, read));
        finished = { result };
        return result;
      });
    } catch (cause) {
      // The work succeeded, so only the release failed. Its result may be a send that already left.
      if (finished) throw new OperationError('eb_fence_release_failed', 'the work finished but the actor fence could not be released', finished, { cause });
      throw cause;
    }
  }

  // Holds the operation's fence across several later calls, none of which share an async
  // context. The checks that precede a pass run before the fence is waited for and again
  // once it is held, so a refusal never leaves the fence held. The fence stays held until
  // release(). The held frame keeps the async scope that acquired the fence (`inFence`),
  // which runPass enters for the fence's ownership check.
  async function holdFence(input) {
    const operation = snapshotOperation(input);
    const read = createReadBudget(clock);
    await precheck(read, operation);
    let release;
    const ended = new Promise((resolve) => { release = resolve; });
    let holding;
    const frame = await new Promise((resolve, reject) => {
      holding = fence.withFence(operation.operationId, async (capability) => {
        const held = { operationId: operation.operationId, capability };
        await refresh(read, operation);
        gate(held, operation);
        resolve({ ...held, inFence: new AsyncResource('dacs-held-fence') });
        await ended;
      });
      holding.catch(reject);
    });
    return {
      run: (work) => operations.run(frame, work),
      release: () => { release(); return holding; },
    };
  }

  async function persist(record) {
    let result;
    try { result = await history.append(record); } catch (cause) {
      throw cause?.code === 'eb_persist_failed' ? cause : refusal('eb_persist_failed', cause);
    }
    if (result?.status !== 'appended') throw refusal('eb_persist_failed', refusal('eb_history_conflict'));
  }

  // Runs `effect` once authorized, for an effect whose record is already durable. A
  // refusal adds `heldState` with its cause and is what the caller sees, also when that
  // record cannot be written.
  // `checked` is the operation the fee check reads when it differs from the recorded one. `authorize`
  // (optional, synchronous) throws when the caller's own authority for the send is gone.
  async function authorizeOrHold(frame, read, operation, passId, heldState, effect, { checked = operation, authorize } = {}) {
    try {
      await refresh(read, checked);
      gate(frame, checked);
      authorize?.();
    } catch (cause) {
      await persist({ ...operation, passId, state: heldState, cause: failureCode(cause) }).catch(() => {});
      throw cause;
    }
    return effect();
  }

  async function readOperation(operation) {
    try { return await history.readOperation(operation); } catch (cause) {
      throw cause?.code === 'eb_history_unavailable' ? cause : refusal('eb_history_unavailable', cause);
    }
  }

  async function refuseSignedOperation(operation) {
    const [recorded] = await readOperation(operation);
    if (recorded) throw refusal('eb_operation_signed', undefined, { artifactHash: recorded.artifactHash });
  }

  async function signPass(input, sign) {
    const operation = snapshotOperation(input);
    return runPass(operation, (frame, read) => signingQueue(JSON.stringify([operation.lane, operation.operationId]), async () => {
      assertPurchaseActionsAdmitted();
      await refuseSignedOperation(operation);
      await refresh(read, operation);
      gate(frame, operation);
      const bytes = await createReadBudget(clock)(sign, 'eb_sign_timeout');
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new TypeError('the signer must return a non-empty Uint8Array');
      await refuseSignedOperation(operation);
      const stored = Buffer.from(bytes);
      const artifact = { ...operation, artifactHash: sha256Hex(stored) };
      await persist({ ...artifact, bytes: stored.toString('base64'), passId: FIRST_PASS, state: 'signed' });
      return authorizeOrHold(frame, read, artifact, FIRST_PASS, 'signed-held', () => artifact);
    }));
  }

  // Hands the operation's retained bytes to `release(bytes, passId)` once the history
  // allows it and `<stage>-started` is durable.
  async function dispatchRetained(frame, read, operation, { explicit, stage, confirmedDebitOs, authorize }, release) {
    const checked = feeView(operation, confirmedDebitOs);
    const records = await readOperation(operation);
    const { state, signed, passId, fresh } = operationState(records, operation, binding.profile?.pinVersion, stage);
    if (state === 'none') throw refusal('eb_history_unavailable');
    if (state === 'possible' && (!REPLAYABLE_KINDS.has(operation.kind) || replayPolicy?.(operation, records) !== true)) throw refusal('eb_readback_required');
    if (state === 'held' && explicit !== true) throw refusal('eb_explicit_resume_required');
    assertPurchaseActionsAdmitted();
    if (fresh) await persist({ ...signed, passId, state: 'signed' });
    assertPurchaseActionsAdmitted();
    await persist({ ...operation, passId, state: `${stage}-started` });
    return authorizeOrHold(frame, read, operation, passId, `${stage}-withheld`, () => release(Buffer.from(signed.bytes, 'base64'), passId), { checked, authorize });
  }

  // The last check of a send that has awaits of its own before it reaches the transport. `final(check, effect)`
  // awaits the stop check, then synchronously runs the admission, fee, connection and revision checks and
  // `check()`, and calls `effect()` in that same run, so nothing is awaited between the checks and the call.
  // What it refuses is noted in `refused`: nothing was transmitted, and the pass is recorded withheld.
  function finalCheck(frame, read, checked, refused) {
    return async (check, effect) => {
      try {
        await checkStop(read);
        gate(frame, checked);
        check();
      } catch (cause) {
        refused.cause = cause;
        throw cause;
      }
      return effect();
    };
  }

  async function dispatchPass(input, send, { explicit = false, stage = 'dispatch', material, confirmedDebitOs, authorize } = {}) {
    if (typeof send !== 'function') throw new TypeError('the effect boundary needs a callable send');
    if (!STAGES.includes(stage)) throw new TypeError(`an effect stage is one of ${STAGES.join(', ')}`);
    const operation = snapshotOperation(input);
    return runPass(operation, (frame, read) => dispatchRetained(frame, read, operation, { explicit, stage, confirmedDebitOs, authorize }, async (bytes, passId) => {
      // An unpaired dispatch-started stays a possible dispatch if the unknown record is lost too; the first cause is the one reported.
      const recordUnknown = (cause) => persist({ ...operation, passId, state: `${stage}-unknown`, cause: failureCode(cause) }).catch(() => {});
      const refused = {};
      let result;
      try {
        result = await send(bytes, finalCheck(frame, read, feeView(operation, confirmedDebitOs), refused));
      } catch (cause) {
        if (refused.cause === undefined) await recordUnknown(cause);
        else await persist({ ...operation, passId, state: `${stage}-withheld`, cause: failureCode(refused.cause) }).catch(() => {});
        throw cause;
      }
      const acknowledged = material ? material(result) : {};
      if (acknowledged === undefined) {
        await recordUnknown({ code: STAGE_ANSWER_NOT_ACCEPTED });
        return result;
      }
      try {
        await persist({ ...operation, ...acknowledged, passId, state: `${stage}-acknowledged` });
      } catch (cause) {
        await recordUnknown(cause);
        throw new OperationError('eb_ack_not_persisted', 'the artifact was sent but its acknowledgement record was not persisted', { result }, { cause });
      }
      return result;
    }));
  }

  return {
    signPass,
    dispatchPass,
    holdFence,
    withOperation: async (input, work) => runPass(snapshotOperation(input), () => work()),
    signerFor(input, signer) {
      const operation = snapshotOperation(input);
      return {
        claim: signer.claim,
        sign: (bytes) => runPass(operation, async () => {
          let signature;
          const artifact = await signPass(operation, async ({ signal }) => {
            signature = await signer.sign(bytes, { signal });
            return typeof signature === 'string' ? Buffer.from(signature) : signature;
          });
          return runPass(artifact, (frame, read) => dispatchRetained(frame, read, artifact, { explicit: false, stage: 'dispatch' }, () => signature));
        }),
      };
    },
    replaceConnection: (replace) => fence.replaceConnection(replace),
  };
}
