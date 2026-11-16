// The client's effect boundary over the actor fence and the dispatch history.
// An operation has one effect per lane: the artifact it signed first. Every
// signature, release and send of it passes the same checks under the fence,
// and is recorded in the history before it leaves. Internal: not exported by
// the package.
import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { assertTp1Binding } from '@kynesyslabs/dacs/wire';
import { OperationError } from '../client-errors.mjs';
import { assertPurchaseActionsAdmitted } from '../dacs/action-admission.mjs';
import { AUTHORITY_READ_DEADLINE_MS } from '../public-admission.mjs';

const UINT = /^(0|[1-9][0-9]*)$/;
const OPERATION_KINDS = new Set(['native', 'confirm', 'create', 'wire', 'signature']);
const REPLAYABLE_KINDS = new Set(['create', 'wire']);
// Each stage that hands bytes to a node or a wallet records `<stage>-started` before and one of the other
// three states after. A stage lists the stages whose transmissions it must treat as possibly sent: a
// confirmation never counts, a recovery dispatch counts for the broadcast, and every stage counts its own.
const STAGE_COUNTS = { dispatch: ['dispatch', 'recovery-dispatch'], 'recovery-dispatch': ['recovery-dispatch'], confirm: [], 'recovery-confirm': [] };
const STAGE_SUFFIXES = ['started', 'withheld', 'acknowledged', 'unknown'];
const STAGE_STATES = new Map(Object.keys(STAGE_COUNTS).flatMap((stage) => STAGE_SUFFIXES.map((suffix) => [`${stage}-${suffix}`, { stage, suffix }])));
const HISTORY_STATES = new Set(['signed', 'signed-held', 'observed', ...STAGE_STATES.keys()]);
const OPERATION_FIELDS = ['operationId', 'lane', 'kind', 'paidWrite', 'debitOs', 'approvalRef', 'k1Rev', 'pinVersion'];
const FIRST_PASS = 'p1';
const systemClock = { now: () => performance.now(), setTimer: setTimeout, clearTimer: clearTimeout };

const refusal = (code, cause, details) => new OperationError(code, `effect refused: ${code}`, details, cause === undefined ? undefined : { cause });
const isDecimal = (value) => typeof value === 'string' && UINT.test(value);
const isThenable = (value) => typeof value?.then === 'function';
const failureCode = (cause) => ({ code: typeof cause?.code === 'string' ? cause.code : 'effect_failed' });
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
// what is left refuses with its timeout code, and a result that arrives later is ignored.
function createReadBudget(clock) {
  let remainingMs = AUTHORITY_READ_DEADLINE_MS;
  return async function read(task, timeoutCode) {
    if (remainingMs <= 0) throw refusal(timeoutCode);
    const startedAt = clock.now();
    let timer;
    try {
      const expired = new Promise((_resolve, reject) => { timer = clock.setTimer(() => reject(refusal(timeoutCode)), remainingMs); });
      const result = await Promise.race([new Promise((resolve) => resolve(task())), expired]);
      if (clock.now() - startedAt >= remainingMs) throw refusal(timeoutCode);
      return result;
    } finally {
      clock.clearTimer(timer);
      remainingMs -= clock.now() - startedAt;
    }
  };
}

// The one state of an operation's effect on its lane for `stage`, from all its records in
// commit order. Possible dispatch outranks held, which outranks signed; anything missing,
// unknown or inconsistent is never evidence that nothing was sent. A stage is held by a
// signed-held record or its own withheld one, and a started pass with no later record
// counts as unknown. A pass reuses the latest signed pass while no other record names it,
// and otherwise starts pass p<n> with a fresh signed record, so two passes that read the
// same records collide on one key and only one of them proceeds.
function operationState(records, operation, pinVersion, stage) {
  if (records.length === 0) return { state: 'none' };
  const counted = STAGE_COUNTS[stage];
  const started = new Map(), withheld = new Set(), signedRecords = [];
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
    if (record.state === 'signed-held') held = true;
    if (record.state === 'observed' && counted.length > 0) possible = true;
    const own = STAGE_STATES.get(record.state);
    if (!own) continue;
    const pass = `${own.stage}/${record.passId}`;
    if (own.suffix === 'started') started.set(pass, own.stage);
    if (own.suffix === 'withheld') {
      if (!started.has(pass)) throw refusal('eb_history_unavailable');
      withheld.add(pass);
      if (own.stage === stage) held = true;
    }
    if ((own.suffix === 'acknowledged' || own.suffix === 'unknown') && counted.includes(own.stage)) possible = true;
  }
  const signed = signedRecords.at(-1);
  const open = records.every((record) => record === signed || record.passId !== signed.passId);
  possible ||= [...started].some(([pass, startedStage]) => counted.includes(startedStage) && !withheld.has(pass));
  return { state: possible ? 'possible' : held ? 'held' : 'signed', signed, passId: open ? signed.passId : `p${signedRecords.length + 1}`, fresh: !open };
}

/**
 * Builds the client's effect boundary. Required host sources, each a TypeError when
 * missing: `binding` (from bindTp1Profile), `currentLocal()`, `stopped()` (boolean or
 * promise), the dispatch `history` and the actor `fence`. `feeCeilingOs` (decimal OS,
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
 * connection and revision with no await before the effect. Every method rejects with
 * the signer's, transport's or authority reader's own error, or an OperationError
 * carrying a refusal code, and always releases the fence it acquired.
 *
 * - `signPass(operation, sign)`: refuses `eb_operation_signed` (with the recorded
 *   `artifactHash` in `details`) once the operation has a record on its lane, without
 *   calling `sign`. Resolves the artifact `{ ...operation, artifactHash }` after `sign()`'s
 *   bytes are durable; a refusal after that leaves `signed-held`.
 * - `dispatchPass(artifact, send, { explicit, stage, material })`: passes the retained bytes
 *   to `send(bytes)` once, after recording `<stage>-started`; a refusal then records
 *   `<stage>-withheld`. `stage` is `dispatch` (the default, the broadcast), `confirm`,
 *   `recovery-confirm` or `recovery-dispatch`, and any other value is a TypeError. A stage's
 *   own records decide what it may repeat: a started pass with no later record counts as
 *   unknown, a confirm stage is never a possible dispatch, and a recovery dispatch counts for
 *   the broadcast. When `material(result)` is given, it returns the fields of
 *   `<stage>-acknowledged` or `undefined` for an answer that is not accepted, which records
 *   `<stage>-unknown` with cause `stage_answer_not_accepted`; `send`'s result is returned
 *   either way. A held or withheld artifact needs `explicit: true`, which a composition sets
 *   only for a fresh request of its own; a possible dispatch refuses `eb_readback_required`;
 *   an artifact that is not the operation's one signed artifact refuses `eb_history_unavailable`.
 * - `withOperation(operation, work)`: holds the fence across `work`; passes made inside
 *   for the same operation reuse it, another operation is refused `tp1_fence_not_owned`.
 *   Do not await `replaceConnection` inside it.
 * - `holdFence(operation)`: refuses early like a pass (admission, stop, fee, binding), then
 *   takes the fence, waiting at most 10,000 ms (`tp1_fence_timeout`), and resolves
 *   `{ run(work), release() }`. The fence stays held across any number of separate calls
 *   until `release()`, which is idempotent and returns the fence's release, so a failed
 *   release is reported. `run(work)` runs `work` as the operation's own frame: its passes
 *   reuse the held fence, and after `release()` they refuse `tp1_fence_not_owned`.
 * - `signerFor(operation, signer)`: a wire signer whose `sign` signs the operation once
 *   and releases the signature like a send: it is recorded as `dispatch-started`, so the
 *   artifact is never sent again by a later `dispatchPass`.
 * - `replaceConnection(replace)`: the fence's connection replacement.
 */
export function createEffectBoundary({ binding, currentLocal, stopped, feeCeilingOs, history, fence, clock = systemClock, currentApproval, currentRevision, replayPolicy } = {}) {
  requireSources({ binding, currentLocal, stopped, history, fence, clock });
  const operations = new AsyncLocalStorage();

  async function checkStop(read) {
    let isStopped;
    try { isStopped = await read(stopped, 'stop_check_timeout'); } catch (cause) {
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
    const read = createReadBudget(clock);
    const enclosing = operations.getStore();
    if (enclosing) {
      if (enclosing.operationId !== operation.operationId) throw refusal('tp1_fence_not_owned');
      return fence.withFence(operation.operationId, () => work(enclosing, read), { capability: enclosing.capability });
    }
    await precheck(read, operation);
    return fence.withFence(operation.operationId, (capability) => {
      const frame = { operationId: operation.operationId, capability };
      return operations.run(frame, () => work(frame, read));
    });
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
  async function authorizeOrHold(frame, read, operation, passId, heldState, effect) {
    try {
      await refresh(read, operation);
      gate(frame, operation);
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
    return runPass(operation, async (frame, read) => {
      await refuseSignedOperation(operation);
      await refresh(read, operation);
      gate(frame, operation);
      const bytes = await sign();
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new TypeError('the signer must return a non-empty Uint8Array');
      await refuseSignedOperation(operation);
      const stored = Buffer.from(bytes);
      const artifact = { ...operation, artifactHash: sha256Hex(stored) };
      await persist({ ...artifact, bytes: stored.toString('base64'), passId: FIRST_PASS, state: 'signed' });
      return authorizeOrHold(frame, read, artifact, FIRST_PASS, 'signed-held', () => artifact);
    });
  }

  // Hands the operation's retained bytes to `release(bytes, passId)` once the history
  // allows `stage` and `<stage>-started` is durable.
  async function dispatchRetained(frame, read, operation, { explicit, stage }, release) {
    const records = await readOperation(operation);
    const { state, signed, passId, fresh } = operationState(records, operation, binding.profile?.pinVersion, stage);
    if (state === 'none') throw refusal('eb_history_unavailable');
    if (state === 'possible' && (!REPLAYABLE_KINDS.has(operation.kind) || replayPolicy?.(operation, records) !== true)) throw refusal('eb_readback_required');
    if (state === 'held' && explicit !== true) throw refusal('eb_explicit_resume_required');
    if (fresh) await persist({ ...signed, passId, state: 'signed' });
    await persist({ ...operation, passId, state: `${stage}-started` });
    return authorizeOrHold(frame, read, operation, passId, `${stage}-withheld`, () => release(Buffer.from(signed.bytes, 'base64'), passId));
  }

  async function dispatchPass(input, send, { explicit = false, stage = 'dispatch', material } = {}) {
    if (!Object.hasOwn(STAGE_COUNTS, stage)) throw new TypeError(`unknown effect stage: ${String(stage)}`);
    if (material !== undefined && typeof material !== 'function') throw new TypeError('the stage material must be a function');
    const operation = snapshotOperation(input);
    return runPass(operation, (frame, read) => dispatchRetained(frame, read, operation, { explicit, stage }, async (bytes, passId) => {
      try {
        const result = await send(bytes);
        const fields = material === undefined ? {} : material(result);
        await persist(fields === undefined
          ? { ...operation, passId, state: `${stage}-unknown`, cause: { code: 'stage_answer_not_accepted' } }
          : { ...fields, ...operation, passId, state: `${stage}-acknowledged` });
        return result;
      } catch (cause) {
        // An unpaired <stage>-started stays unknown if this record is lost too; the first cause is the one reported.
        await persist({ ...operation, passId, state: `${stage}-unknown`, cause: failureCode(cause) }).catch(() => {});
        throw cause;
      }
    }));
  }

  async function holdFence(input) {
    const operation = snapshotOperation(input);
    await precheck(createReadBudget(clock), operation);
    let endHold;
    const ended = new Promise((resolve) => { endHold = resolve; });
    let holding;
    const frame = await new Promise((resolve, reject) => {
      holding = fence.withFence(operation.operationId, (capability) => { resolve({ operationId: operation.operationId, capability }); return ended; });
      holding.catch(reject);
    });
    return { run: (work) => operations.run(frame, work), release: () => { endHold(); return holding; } };
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
          const artifact = await signPass(operation, async () => {
            signature = await signer.sign(bytes);
            return typeof signature === 'string' ? Buffer.from(signature) : signature;
          });
          return runPass(artifact, (frame, read) => dispatchRetained(frame, read, artifact, { explicit: false, stage: 'dispatch' }, () => signature));
        }),
      };
    },
    replaceConnection: (replace) => fence.replaceConnection(replace),
  };
}
