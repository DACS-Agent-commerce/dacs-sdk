// The client's effect boundary (K0 EB1-EB9) over the actor fence and the dispatch
// history. Internal: not exported by the package, and no wallet path calls it yet.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { assertTp1Binding } from '@kynesyslabs/dacs/wire';
import { OperationError } from '../client-errors.mjs';
import { assertPurchaseActionsAdmitted } from '../dacs/action-admission.mjs';
import { AUTHORITY_READ_DEADLINE_MS } from '../public-admission.mjs';

const UINT = /^(0|[1-9][0-9]*)$/;
const ARTIFACT_HASH = /^[0-9a-f]{64}$/;
const OPERATION_KINDS = new Set(['native', 'confirm', 'create', 'wire', 'signature']);
const REPLAYABLE_KINDS = new Set(['create', 'wire']);
const HISTORY_STATES = new Set(['signed', 'signed-held', 'dispatch-started', 'dispatch-withheld', 'dispatch-acknowledged', 'dispatch-unknown', 'observed']);
const POSSIBLE_DISPATCH_STATES = new Set(['dispatch-unknown', 'dispatch-acknowledged', 'observed']);
const OPERATION_FIELDS = ['operationId', 'lane', 'kind', 'paidWrite', 'debitOs', 'approvalRef', 'k1Rev', 'pinVersion'];
const systemClock = { now: () => performance.now(), setTimer: setTimeout, clearTimer: clearTimeout };

const refusal = (code, cause) => new OperationError(code, `effect refused: ${code}`, undefined, cause === undefined ? undefined : { cause });
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
  if (typeof history?.append !== 'function' || typeof history?.read !== 'function') throw new TypeError('the effect boundary needs a dispatch history');
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

// The whole retained history of one artifact: whether a record holds it back
// (signed-held, dispatch-withheld) and whether any pass may have transmitted it. A
// dispatch-started without its own dispatch-withheld stays a possible dispatch.
// Missing, unknown or inconsistent records are never evidence that nothing was sent.
function classifyHistory(records, operation, currentPinVersion) {
  const started = new Set(), withheld = new Set();
  let signed, held = false, possible = false;
  for (const record of records) {
    if (record.pinVersion !== currentPinVersion) throw refusal('pin_version_retired');
    if (!HISTORY_STATES.has(record.state) || canonicalize(operationMetadata(record)) !== canonicalize(operationMetadata(operation))) throw refusal('eb_history_unavailable');
    if (record.state === 'signed') {
      const bytes = typeof record.bytes === 'string' ? Buffer.from(record.bytes, 'base64') : null;
      if (!bytes || bytes.toString('base64') !== record.bytes || sha256Hex(bytes) !== operation.artifactHash) throw refusal('eb_history_unavailable');
      signed = record;
    } else if (!signed) throw refusal('eb_history_unavailable');
    if (record.state === 'signed-held' || record.state === 'dispatch-withheld') held = true;
    if (record.state === 'dispatch-started') started.add(record.passId);
    if (record.state === 'dispatch-withheld') {
      if (!started.has(record.passId)) throw refusal('eb_history_unavailable');
      withheld.add(record.passId);
    }
    if (POSSIBLE_DISPATCH_STATES.has(record.state)) possible = true;
  }
  if (!signed) throw refusal('eb_history_unavailable');
  return { signed, held, possible: possible || [...started].some((passId) => !withheld.has(passId)) };
}

/**
 * Builds the client's effect boundary. Required host sources, each a TypeError when
 * missing: `binding` (from bindTp1Profile), `currentLocal()`, `stopped()` (boolean or
 * promise), `history` and `fence` (P16a1a's). `feeCeilingOs` (decimal OS, no default) is
 * needed by a paid write at EB3 and refuses `fee_ceiling_required` without it. `clock`
 * is `{ now, setTimer, clearTimer }`, monotonic by default. An operation carrying an
 * `approvalRef` `{ rev }` needs a synchronous `currentApproval(approvalRef)` that
 * returns `{ rev, open }`; one carrying `k1Rev` needs a synchronous
 * `currentRevision(operationId)`. `replayPolicy(operation, records)` (synchronous,
 * `true` to allow) is the only way a CREATE or wire artifact with a possible dispatch
 * is replayed; a native or confirm artifact never is.
 *
 * An operation is `{ operationId, lane, kind, paidWrite, debitOs?, approvalRef?, k1Rev?,
 * pinVersion }`. Every method rejects with the signer's, transport's or authority
 * reader's own error, or an OperationError carrying the K0 refusal code, and always
 * releases the fence it acquired.
 *
 * - `signPass(operation, sign)`: EB1-EB7. Resolves the artifact `{ ...operation, artifactHash }`
 *   after `sign()`'s bytes are durable; a refusal after that leaves `signed-held`.
 * - `dispatchPass(artifact, send, { explicit })`: EB1-EB5r, EB7-EB9 on the retained
 *   bytes, passed to `send(bytes)` once. A held or withheld artifact needs `explicit: true`,
 *   which a composition sets only for a fresh request of its own; a possible dispatch
 *   refuses `eb_readback_required`. When `send` returned but the acknowledgement record
 *   could not be written, it rejects `eb_ack_not_persisted`: the artifact was sent, the
 *   send's return value is `error.details.result`, and the write failure is `error.cause`.
 * - `withOperation(operation, work)`: holds the fence across `work`; passes made inside
 *   for the same operation reuse it, another operation is refused `tp1_fence_not_owned`.
 *   Do not await `replaceConnection` inside it.
 * - `signerFor(operation, signer)`: a wire signer whose `sign` is one `signPass`, so a
 *   library's signature is checked after the library's own authority read and persisted
 *   before it is returned.
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

  // EB1-EB4: refuse early. They authorize nothing after the fence wait.
  async function precheck(read, operation) {
    assertPurchaseActionsAdmitted();
    await checkStop(read);
    checkFee(operation);
    await checkBinding(read, operation);
  }

  // EB5r, awaited part: EB1-EB4 again with the fence held, then the final stop check after the final authority read.
  async function refresh(read, operation) {
    await precheck(read, operation);
    await checkStop(read);
  }

  // Synchronous: EB5r's tail before the signer and EB8f's before the transmission. No await may follow.
  function assertStillAuthorized(frame, operation) {
    assertPurchaseActionsAdmitted();
    checkFee(operation);
    assertSameConnection(frame.capability);
    if (operation.k1Rev !== undefined) {
      const revision = currentRevision?.(operation.operationId);
      if (revision === undefined || isThenable(revision) || revision !== operation.k1Rev) throw refusal('context_admission_closed');
    }
  }

  // EB5: one pass under the operation's fence capability, its own or the enclosing operation's.
  async function runPass(operation, work) {
    const read = createReadBudget(clock);
    const enclosing = operations.getStore();
    if (enclosing) {
      if (enclosing.operationId !== operation.operationId) throw refusal('tp1_fence_not_owned');
      return fence.withFence(operation.operationId, () => work(enclosing, read), { capability: enclosing.capability });
    }
    await precheck(read, operation);
    return fence.withFence(operation.operationId, (capability) => {
      const frame = { operationId: operation.operationId, capability, signed: new Set(), dispatching: new Set() };
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

  async function readHistory(artifact) {
    try { return await history.read(artifact); } catch (cause) {
      throw cause?.code === 'eb_history_unavailable' ? cause : refusal('eb_history_unavailable', cause);
    }
  }

  // EB7: the signed bytes are durable; a refusal keeps them as signed-held evidence.
  async function recheckSigned(frame, read, operation, passId) {
    try {
      assertPurchaseActionsAdmitted();
      await checkStop(read);
      await checkBinding(read, operation);
      assertSameConnection(frame.capability);
    } catch (cause) {
      await persist({ ...operation, passId, state: 'signed-held', cause: failureCode(cause) });
      throw cause;
    }
  }

  async function signPass(input, sign) {
    const operation = snapshotOperation(input);
    return runPass(operation, async (frame, read) => {
      await refresh(read, operation);
      assertStillAuthorized(frame, operation);
      const bytes = await sign();
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new TypeError('the signer must return a non-empty Uint8Array');
      const stored = Buffer.from(bytes);
      const artifact = { ...operation, artifactHash: sha256Hex(stored) };
      const passId = randomUUID();
      await persist({ ...artifact, bytes: stored.toString('base64'), passId, state: 'signed' });
      await recheckSigned(frame, read, artifact, passId);
      frame.signed.add(`${artifact.lane}/${artifact.artifactHash}`);
      return artifact;
    });
  }

  // EB8-EB9 on the retained bytes. The history's verdict decides whether this pass may send at all.
  async function dispatchRetained(frame, read, operation, send, explicit) {
    const key = `${operation.lane}/${operation.artifactHash}`;
    if (!frame.signed.has(key)) { await refresh(read, operation); assertStillAuthorized(frame, operation); }
    if (!ARTIFACT_HASH.test(operation.artifactHash)) throw refusal('eb_history_unavailable');
    const records = await readHistory(operation);
    const retained = classifyHistory(records, operation, binding.profile?.pinVersion);
    if (retained.possible && (!REPLAYABLE_KINDS.has(operation.kind) || replayPolicy?.(operation, records) !== true)) throw refusal('eb_readback_required');
    if (retained.held && explicit !== true) throw refusal('eb_explicit_resume_required');
    const freshPass = retained.held || retained.possible;
    const passId = freshPass ? randomUUID() : retained.signed.passId;
    if (freshPass) {
      const signedRecord = { ...retained.signed, passId, state: 'signed' };
      delete signedRecord.seq;
      await persist(signedRecord);
    }
    if (!frame.signed.has(key)) await recheckSigned(frame, read, operation, passId);
    await persist({ ...operation, passId, state: 'dispatch-started' });
    const bytes = Buffer.from(retained.signed.bytes, 'base64');
    try {
      await checkStop(read);
      assertStillAuthorized(frame, operation);
    } catch (cause) {
      await persist({ ...operation, passId, state: 'dispatch-withheld', cause: failureCode(cause) });
      throw cause;
    }
    // An unpaired dispatch-started stays a possible dispatch if the unknown record is lost too; the first cause is the one reported.
    const recordUnknown = (cause) => persist({ ...operation, passId, state: 'dispatch-unknown', cause: failureCode(cause) }).catch(() => {});
    let result;
    try {
      result = await send(bytes);
    } catch (cause) {
      await recordUnknown(cause);
      throw cause;
    }
    try {
      await persist({ ...operation, passId, state: 'dispatch-acknowledged' });
    } catch (cause) {
      await recordUnknown(cause);
      throw new OperationError('eb_ack_not_persisted', 'the artifact was sent but its acknowledgement record was not persisted', { result }, { cause });
    }
    return result;
  }

  async function dispatchPass(input, send, { explicit = false } = {}) {
    const operation = snapshotOperation(input);
    return runPass(operation, (frame, read) => {
      if (frame.dispatching.has(operation.lane)) throw refusal('eb_lane_busy');
      frame.dispatching.add(operation.lane);
      return dispatchRetained(frame, read, operation, send, explicit).finally(() => frame.dispatching.delete(operation.lane));
    });
  }

  return {
    signPass,
    dispatchPass,
    withOperation: (input, work) => runPass(snapshotOperation(input), () => work()),
    signerFor(input, signer) {
      const operation = snapshotOperation(input);
      return {
        claim: signer.claim,
        async sign(bytes) {
          let signature;
          await signPass(operation, async () => {
            signature = await signer.sign(bytes);
            return typeof signature === 'string' ? Buffer.from(signature) : signature;
          });
          return signature;
        },
      };
    },
    replaceConnection: (replace) => fence.replaceConnection(replace),
  };
}
