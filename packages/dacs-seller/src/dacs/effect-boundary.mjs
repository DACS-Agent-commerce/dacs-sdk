// The kit's effect boundary (K0): every signature that authorizes an effect and every
// transmission passes EB1 to EB9 in order, under one actor-local fence, with its signed
// bytes and dispatch intent durable before anything leaves the process. Nothing in the kit
// calls it yet. Errors are WireError (code, status, cause kept) or the guard's own error.
import { createHash } from 'node:crypto';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { WireError, assertTp1Binding } from '@kynesyslabs/dacs/wire';
import { assertKitOperationAdmitted } from '../kit-operation-guard.mjs';

// Monotonic window for authority and stop reads, in milliseconds: one for EB1 to EB4, and one that starts when the fence is acquired and covers EB5r to EB8f.
const EFFECT_READ_DEADLINE_MS = 10000;
// Longest wait for the actor fence, in milliseconds.
const EFFECT_FENCE_TIMEOUT_MS = 10000;
const MAX_SIGNED_BYTES = 262144;
const MAX_OPERATION_ID_LENGTH = 256;
const MAX_CAUSE_MESSAGE_LENGTH = 256;
const STAGES = ['dispatch', 'confirm', 'broadcast'];
const JOB_OPERATION_CLASSES = ['job-create', 'payment-evidence', 'job-resume'];
// Whether the retained bytes may be sent again after an earlier stage may have reached transport (K0 lane policy).
const KINDS = { 'native-transaction': { mayResend: false }, 'seller-create': { mayResend: true }, 'wire-request': { mayResend: true } };
const NOT_STOPPED_STATUS = 503;

const assertAdmitted = () => assertKitOperationAdmitted('effectBoundary');
const refuse = (code, detail, cause, status = 500) => new WireError(code, status, detail, cause);
const timeoutCause = (ms) => Object.assign(new Error(`no answer within ${ms} ms`), { name: 'TimeoutError' });
const parseOs = (value) => (typeof value === 'bigint' && value >= 0n ? value : typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : null);
const hashOf = (bytes) => createHash('sha256').update(bytes).digest('hex');
// What a history record keeps of a refusal or a transport error: its code (or name) and a bounded message.
const describeCause = (error) => ({ code: String(error?.code ?? error?.name ?? 'Error'), message: String(error?.message ?? error).slice(0, MAX_CAUSE_MESSAGE_LENGTH) });
// The artifact's `${stage}-started` records with no durable withheld record of their own: each may have reached transport.
const unwithdrawnStarts = (records, artifactHash) => records.filter((record) => record.artifactHash === artifactHash && record.state.endsWith('-started')
  && !records.some((other) => other.state === record.state.replace('-started', '-withheld') && other.of === record.seq));

// The artifact's confirmation is established by its own acknowledgement, or by a readback that found that confirm transmission (an `observed` record whose `of` is a `confirm-started` record of the artifact).
const confirmationEstablished = (records, artifactHash) => records.some((record) => record.artifactHash === artifactHash && (record.state === 'confirm-acknowledged'
  || (record.state === 'observed' && records.some((started) => started.seq === record.of && started.state === 'confirm-started' && started.artifactHash === artifactHash))));

// A pass's job class and private current-authorization check come only from jobPassContext, never from a request.
const contexts = new WeakSet();
const brand = (context) => { contexts.add(context); return Object.freeze(context); };
const PLAIN_CONTEXT = brand({ operationClass: null, currentAuthorization: null });

/**
 * The private context of a seller job pass: its class ('job-create', 'payment-evidence' or 'job-resume')
 * and `currentAuthorization()`, a synchronous check of settlement credit, job ownership and the validated
 * revision that returns true or throws its cause. A job pass without a usable check refuses. Throws
 * TypeError for an unknown class. Composition code only: the boundary refuses any other object.
 */
export function jobPassContext(operationClass, currentAuthorization) {
  if (!JOB_OPERATION_CLASSES.includes(operationClass)) throw new TypeError(`operationClass must be one of ${JOB_OPERATION_CLASSES.join(', ')}`);
  return brand({ operationClass, currentAuthorization });
}

function assertCurrentAuthorization({ operationClass, currentAuthorization }) {
  if (operationClass === null) return;
  if (typeof currentAuthorization !== 'function') throw refuse('context_authorization_required', `a ${operationClass} pass has no current-authorization check`);
  const result = currentAuthorization();
  if (result === true) return;
  if (typeof result?.then === 'function') Promise.resolve(result).catch(() => {});
  throw refuse('context_authorization_refused', typeof result?.then === 'function' ? 'the check answered asynchronously' : 'the check did not return true');
}

// Waits for `work` until the window's deadline: { value } or { timedOut: true }; a late answer is ignored and never unhandled.
function within(clock, deadline, work) {
  return new Promise((resolve, reject) => {
    const remaining = deadline - clock.now();
    if (remaining <= 0) return resolve({ timedOut: true });
    const cancel = clock.after(remaining, () => resolve({ timedOut: true }));
    Promise.resolve().then(work).then((value) => resolve({ value }), reject).finally(cancel);
  });
}

// FIFO actor fence. A waiter that timed out leaves the queue, so a release can never grant it.
function createFence(clock) {
  let holder = null;
  const waiting = [];
  const grantNext = () => {
    if (holder !== null || waiting.length === 0) return;
    const waiter = waiting.shift();
    holder = waiter.token;
    waiter.cancel();
    waiter.resolve(waiter.token);
  };
  return {
    acquire: () => new Promise((resolve, reject) => {
      const waiter = { token: Object.freeze({}), resolve, cancel: () => {} };
      waiter.cancel = clock.after(EFFECT_FENCE_TIMEOUT_MS, () => {
        waiting.splice(waiting.indexOf(waiter), 1);
        reject(refuse('tp1_fence_timeout', undefined, timeoutCause(EFFECT_FENCE_TIMEOUT_MS)));
      });
      waiting.push(waiter);
      grantNext();
    }),
    release(token) { if (holder === token) { holder = null; grantNext(); } },
  };
}

// The shape of `op`; a pass also requires it to carry the current pin version (checkOperationPin).
function checkOperation(op) {
  const malformed = (field) => refuse('eb_operation_invalid', `${field} is missing or malformed`);
  if (op === null || typeof op !== 'object') throw malformed('op');
  if (typeof op.operationId !== 'string' || op.operationId === '' || op.operationId.length > MAX_OPERATION_ID_LENGTH) throw malformed('operationId');
  if (typeof op.lane !== 'string' || op.lane === '') throw malformed('lane');
  if (!Object.hasOwn(KINDS, op.kind)) throw malformed('kind');
  if (typeof op.paidWrite !== 'boolean') throw malformed('paidWrite');
  if (op.approvalRef != null && typeof op.approvalRef.revision !== 'function') throw malformed('approvalRef');
  if (op.k1Rev != null && typeof op.k1Rev.current !== 'function') throw malformed('k1Rev');
}

function checkOperationPin(op, pinVersion) {
  if (op.pinVersion !== pinVersion) throw refuse('pin_version_retired', 'the operation is stamped with another pin version');
}

function assertStage(stage) {
  if (!STAGES.includes(stage)) throw refuse('eb_operation_invalid', `stage must be one of ${STAGES.join(', ')}`);
}

/**
 * Builds the kit's effect boundary over `{ stopped, binding, currentLocal, feeCeilingOs, history, clock }`:
 * `stopped()` the required stop check (boolean or promise of one), `binding` from bindTp1Profile,
 * `currentLocal()` the actor's connection, `feeCeilingOs` the per-write ceiling in OS (decimal string or
 * bigint; null refuses paid writes with fee_ceiling_required), `history` a createEffectHistory(), `clock`
 * `{ now(), after(ms, callback) -> cancel }` on a monotonic source. The kit guard is read at every check.
 * Throws TypeError for a missing or malformed input. An `op` is `{ operationId, lane, kind, paidWrite,
 * debitOs, approvalRef, k1Rev, pinVersion }`: `kind` is 'native-transaction' (never sent twice in a
 * stage), 'seller-create' or 'wire-request' (retained bytes may be sent again by a new pass);
 * `approvalRef` null or `{ revision() }` (null once the hold is gone); `k1Rev` null or `{ expected, current() }`.
 * Every method rejects (`signerFor` throws) with a WireError naming K0's refusal code, keeping its cause; a
 * callback's own error (a signer, a transport, `currentAuthorization`) is passed through unchanged.
 * - `withFence(op, work, { context })` runs EB1 to EB5, then `work(held)` with `held.capability`, and releases.
 * - `signPass(op, innerSign, { context })` runs EB5r to EB7; resolves `{ bytes, artifactHash }`, signing only when nothing is retained.
 * - `dispatchPass(held, innerSend, { stage })` runs EB8 to EB9 for the bytes `signPass(held)` returned; resolves the send's answer.
 * - `pass(op, innerSign, innerSend, { stage, context })` is both under one fence; resolves `{ bytes, answer }`.
 * - `signerFor(held, inner)` is a wire signer that runs EB5r's final tail inside `sign`.
 * - `recordObserved(op, stage, result)` records a readback that found the stage's transmission; for 'confirm' it
 *   counts as the acknowledgement a broadcast requires.
 * - `replaceConnection(replace, capability)` replaces the connection under the fence and bumps `connectionGeneration()`.
 */
export function createEffectBoundary({ stopped, binding, currentLocal, feeCeilingOs = null, history, clock }) {
  for (const [name, value] of Object.entries({ stopped, currentLocal })) if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  if (binding?.profile?.pinVersion === undefined || typeof binding.localDigest !== 'string') throw new TypeError('binding must come from bindTp1Profile');
  if (typeof history?.read !== 'function' || typeof history?.append !== 'function') throw new TypeError('history must be a createEffectHistory()');
  if (typeof clock?.now !== 'function' || typeof clock?.after !== 'function') throw new TypeError('clock must have now() and after()');
  const ceiling = feeCeilingOs === null ? null : parseOs(feeCeilingOs);
  if (feeCeilingOs !== null && ceiling === null) throw new TypeError('feeCeilingOs must be a non-negative integer in OS');
  const fence = createFence(clock);
  const passes = new WeakMap();
  let generation = 0;

  const newWindow = () => clock.now() + EFFECT_READ_DEADLINE_MS;
  const localDigest = () => {
    try { return sha256Hex(canonicalize(currentLocal())); } catch (cause) { throw refuse('tp1_local_binding_changed', 'the current connection cannot be read', cause); }
  };

  async function checkNotStopped(deadline) {
    let outcome;
    try { outcome = await within(clock, deadline, stopped); } catch (cause) { throw refuse('stop_check_failed', undefined, cause, NOT_STOPPED_STATUS); }
    if (outcome.timedOut) throw refuse('stop_check_timeout', undefined, timeoutCause(EFFECT_READ_DEADLINE_MS), NOT_STOPPED_STATUS);
    if (typeof outcome.value !== 'boolean') throw refuse('stop_check_invalid', `the stop check answered ${typeof outcome.value}`, undefined, NOT_STOPPED_STATUS);
    if (outcome.value) throw refuse('seller_stopped', undefined, undefined, NOT_STOPPED_STATUS);
  }

  async function checkBinding(deadline) {
    const outcome = await within(clock, deadline, () => assertTp1Binding(binding, currentLocal()));
    if (outcome.timedOut) throw refuse('tp1_authority_timeout', undefined, timeoutCause(EFFECT_READ_DEADLINE_MS));
  }

  // EB3: the policy cap and the approval hold. Returns the hold's revision (null without one); a hold that is gone or has changed refuses.
  function checkFeeAndApproval(op, expectedRevision) {
    if (op.paidWrite) {
      if (ceiling === null) throw refuse('fee_ceiling_required', 'no per-write fee ceiling was supplied');
      const debit = parseOs(op.debitOs);
      if (debit === null || debit > ceiling) throw refuse('write-fee-cap', 'above the 50 DEM ceiling per write');
    }
    return checkApproval(op, expectedRevision);
  }

  function checkApproval(op, expectedRevision) {
    if (op.approvalRef == null) return null;
    const revision = op.approvalRef.revision();
    if (revision === null || revision === undefined || (expectedRevision !== undefined && revision !== expectedRevision)) throw refuse('write-fee-cap', 'above the approved total: the approval hold is gone');
    return revision;
  }

  // EB1 to EB4: the pre-checks, and EB5r's refresh.
  async function preChecks(op, deadline, expectedRevision) {
    assertAdmitted();
    await checkNotStopped(deadline);
    const revision = checkFeeAndApproval(op, expectedRevision);
    await checkBinding(deadline);
    return revision;
  }

  // The connection is still the bound one, and still the one this pass acquired the fence on.
  function checkLocal(pass) {
    const digest = localDigest();
    if (digest !== binding.localDigest || digest !== pass.digest || generation !== pass.generation) throw refuse('tp1_local_binding_changed', 'the connection changed during the pass');
  }

  // The synchronous tail of EB5r and EB8f (approval hold, connection, K1 revision, current authorization): nothing awaits between it and the signer or the transmission.
  function recheckNow(pass, op) {
    assertAdmitted();
    checkApproval(op, pass.approvalRevision);
    checkLocal(pass);
    if (op.k1Rev != null && op.k1Rev.current() !== op.k1Rev.expected) throw refuse('context_admission_closed', 'the K1 revision moved');
    assertCurrentAuthorization(pass.context);
  }

  function livePass(capability) {
    const pass = passes.get(capability);
    if (pass === undefined || pass.released) throw refuse('tp1_fence_not_owned', 'the capability is not a live fence owner');
    return pass;
  }

  function ownedPass(op) {
    const pass = livePass(op.capability);
    if (pass.operationId !== op.operationId || pass.lane !== op.lane) throw refuse('tp1_fence_not_owned', 'the capability belongs to another operation');
    return pass;
  }

  // EB5: runs `work(held)` while this operation owns the fence, or reuses the owner's capability when `op` presents one. `bind` records the connection digest.
  async function hold(op, context, work, { approvalRevision = null, bind = false } = {}) {
    if (op.capability !== undefined) { ownedPass(op); return work(op); }
    const token = await fence.acquire();
    const pass = { operationId: op.operationId, lane: op.lane, generation, digest: null, approvalRevision, context, deadline: newWindow(), released: false, sealed: null };
    passes.set(token, pass);
    try {
      if (bind) pass.digest = localDigest();
      return await work(Object.freeze({ ...op, capability: token }));
    } finally { pass.released = true; fence.release(token); }
  }

  async function withFence(op, work, { context = PLAIN_CONTEXT } = {}) {
    assertAdmitted();
    checkOperation(op);
    checkOperationPin(op, binding.profile.pinVersion);
    if (!contexts.has(context)) throw refuse('eb_context_invalid', 'the pass context did not come from jobPassContext');
    if (op.capability !== undefined) { ownedPass(op); return work(op); }
    const approvalRevision = await preChecks(op, newWindow());
    return hold(op, context, work, { approvalRevision, bind: true });
  }

  function assertLanePin(records) {
    if (records.some((record) => record.pinVersion !== binding.profile.pinVersion)) throw refuse('pin_version_retired', 'the lane holds a record of another pin version');
  }

  const base = (op, artifactHash) => ({ operationId: op.operationId, pinVersion: op.pinVersion, artifactHash });

  function retainedSigned(records, op) {
    const record = records.findLast((entry) => entry.state === 'signed' && entry.operationId === op.operationId);
    if (record === undefined) return null;
    const bytes = new Uint8Array(Buffer.from(record.bytes ?? '', 'base64'));
    if (bytes.length === 0 || hashOf(bytes) !== record.artifactHash) throw refuse('eb_history_unavailable', `the retained bytes of ${op.operationId} do not match their hash`);
    return { bytes, artifactHash: record.artifactHash };
  }

  async function signUnderFence(op, innerSign) {
    const pass = ownedPass(op);
    const { deadline } = pass;
    const records = await history.read(op.lane);
    assertLanePin(records);
    const retained = retainedSigned(records, op);
    await preChecks(op, deadline, pass.approvalRevision);
    await checkNotStopped(deadline);
    recheckNow(pass, op);
    const produced = retained === null ? innerSign() : null;
    const signed = retained?.bytes ?? await produced;
    if (!(signed instanceof Uint8Array) || signed.length === 0 || signed.length > MAX_SIGNED_BYTES) throw refuse('eb_signed_bytes_invalid', `the signer must return 1 to ${MAX_SIGNED_BYTES} bytes`);
    // The pass keeps its own copy: the signer may still hold the array it returned, and the hash, the record and every transmission must use the same bytes.
    const bytes = Uint8Array.from(signed);
    const artifactHash = retained?.artifactHash ?? hashOf(bytes);
    if (retained === null) {
      const approval = pass.approvalRevision === null ? {} : { approval: pass.approvalRevision };
      await history.append(op.lane, { state: 'signed', ...base(op, artifactHash), ...approval, bytes: Buffer.from(bytes).toString('base64') });
    }
    try {
      assertAdmitted();
      await checkNotStopped(deadline);
      await checkBinding(deadline);
      checkApproval(op, pass.approvalRevision);
      checkLocal(pass);
    } catch (refusal) {
      await history.append(op.lane, { state: 'signed-held', ...base(op, artifactHash), cause: describeCause(refusal) })
        .catch((cause) => { throw refuse('eb_persist_failed', `the signed-held record for ${refusal.code} could not be written`, cause); });
      throw refusal;
    }
    pass.sealed = { bytes, artifactHash };
    return { bytes: Uint8Array.from(bytes), artifactHash };
  }

  function signPass(op, innerSign, { context } = {}) {
    return withFence(op, (held) => signUnderFence(held, innerSign), { context });
  }

  async function dispatchPass(op, innerSend, { stage = 'dispatch' } = {}) {
    const pass = ownedPass(op);
    if (pass.sealed === null) throw refuse('eb_dispatch_without_sign_pass', 'dispatchPass follows a signPass under the same fence');
    assertStage(stage);
    const { bytes, artifactHash } = pass.sealed;
    const records = await history.read(op.lane);
    assertLanePin(records);
    if (!KINDS[op.kind].mayResend && unwithdrawnStarts(records, artifactHash).some((record) => record.state === `${stage}-started`)) throw refuse('lane_readback_only', `${stage} may already have reached transport`);
    if (stage === 'broadcast' && !confirmationEstablished(records, artifactHash)) throw refuse('confirm_not_acknowledged', 'broadcast follows an acknowledged confirmation');
    const intent = await history.append(op.lane, { state: `${stage}-started`, ...base(op, artifactHash) });
    if (!intent.created) throw refuse('lane_readback_only', `${stage} intent was already recorded by an earlier run`);
    const of = intent.record.seq;
    try {
      await checkNotStopped(pass.deadline);
      recheckNow(pass, op);
    } catch (refusal) {
      await history.append(op.lane, { state: `${stage}-withheld`, ...base(op, artifactHash), of, cause: describeCause(refusal) })
        .catch((cause) => { throw refuse('eb_persist_failed', `the ${stage}-withheld record for ${refusal.code} could not be written`, cause); });
      throw refusal;
    }
    let answer;
    try { answer = await innerSend(Uint8Array.from(bytes)); } catch (error) {
      // A missing record leaves `-started`, which already means "possibly sent", so the send's own error is what the caller gets.
      await history.append(op.lane, { state: `${stage}-unknown`, ...base(op, artifactHash), of, cause: describeCause(error) }).catch(() => {});
      throw error;
    }
    await history.append(op.lane, { state: `${stage}-acknowledged`, ...base(op, artifactHash), of });
    return answer;
  }

  return Object.freeze({
    withFence, signPass, dispatchPass,
    pass: (op, innerSign, innerSend, { stage, context } = {}) => withFence(op, async (held) => {
      const { bytes } = await signUnderFence(held, innerSign);
      return { bytes, answer: await dispatchPass(held, innerSend, { stage }) };
    }, { context }),
    signerFor(op, inner) {
      assertAdmitted();
      const pass = ownedPass(op);
      return Object.freeze({
        claim: inner.claim,
        async sign(bytes) {
          await checkNotStopped(pass.deadline);
          ownedPass(op);
          recheckNow(pass, op);
          return inner.sign(bytes);
        },
      });
    },
    async recordObserved(op, stage, result) {
      checkOperation(op);
      assertStage(stage);
      return hold(op, PLAIN_CONTEXT, async () => {
        const records = await history.read(op.lane);
        const retained = retainedSigned(records, op);
        const started = retained === null ? undefined : unwithdrawnStarts(records, retained.artifactHash).findLast((record) => record.state === `${stage}-started`);
        if (started === undefined) throw refuse('eb_observation_unexpected', `no ${stage} transmission of ${op.operationId} to observe`);
        return history.append(op.lane, { state: 'observed', ...base(op, retained.artifactHash), of: started.seq, result });
      });
    },
    async replaceConnection(replace, capability = null) {
      const replaceAndCount = async () => { try { await replace(); } finally { generation += 1; } };
      if (capability !== null) { livePass(capability); return replaceAndCount(); }
      const token = await fence.acquire();
      try { await replaceAndCount(); } finally { fence.release(token); }
    },
    connectionGeneration: () => generation,
  });
}
