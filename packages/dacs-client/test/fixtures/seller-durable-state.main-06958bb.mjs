// Opt-in host-local recovery for the SIMULATED seller adapter. This retains
// seller-authenticated application context beside the pinned SDK stores. It
// never obtains a buyer key or reconstructs facts from a cached HTTP answer.
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalize, contentHash, createFsFencedSessionStore, createFsSellerReceiptStore, isCanonicalJobId, sha256Hex } from '@kynesyslabs/dacs';
import { verifyFixtureRecord } from './fixture-anchors.mjs';

const DOMAIN = 'dacs-chatgpt-plugin:offline-seller-state:v1:';
const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => canonicalize(a) === canonicalize(b);
const fail = (code) => { throw new SellerRecoveryError(code); };

export class SellerRecoveryError extends Error {
  constructor(code) { super(code); this.code = code; this.status = 503; }
}

export async function createSellerDurableState({ dir, signer, listingPin, maxJobs = 1000 }) {
  if (typeof dir !== 'string' || !isAbsolute(dir) || !/^did:demos:agent:[0-9a-f]{64}$/.test(signer?.claim) || typeof signer.sign !== 'function' || !Number.isSafeInteger(maxJobs) || maxJobs < 1) fail('seller_state_configuration_invalid');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || realpathSync(dir) !== dir) fail('seller_state_directory_unsafe');
  const path = join(dir, 'seller-state.sqlite');
  try {
    lstatSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (readdirSync(dir).length) fail('seller_state_missing_database');
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
  }
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.() || (file.mode & 0o077)) fail('seller_state_file_unsafe');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(signer.claim.slice(16), 'hex')]), format: 'der', type: 'spki' });
  const db = new DatabaseSync(path);
  const owner = `${process.pid}:${randomUUID()}`;
  const owned = new Map();
  const pin = clone(listingPin);
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000');
  db.exec(`CREATE TABLE IF NOT EXISTS seller_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS seller_jobs (job TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS seller_effects (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS seller_settlements (id TEXT PRIMARY KEY, job TEXT NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS seller_locks (job TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL);`);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function authenticated(kind, id, body) {
    const payload = { version: '1', kind, id, seller: signer.claim, listingPin: pin, body: clone(body) };
    const bytes = Buffer.from(`${DOMAIN}${canonicalize(payload)}`);
    const signature = Buffer.from(signer.sign(bytes));
    if (signature.length !== 64 || !verify(null, bytes, key, signature)) fail('seller_state_signer_invalid');
    return JSON.stringify({ payload, signature: signature.toString('base64url') });
  }
  function verified(value, kind, id) {
    try {
      const envelope = JSON.parse(value);
      const { payload: p, signature } = envelope;
      if (Object.keys(envelope).sort().join(',') !== 'payload,signature' || Object.keys(p).sort().join(',') !== 'body,id,kind,listingPin,seller,version' || p.version !== '1' || p.kind !== kind || p.id !== id || p.seller !== signer.claim || !same(p.listingPin, pin) || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) fail('seller_state_corrupt');
      const sig = Buffer.from(signature, 'base64url');
      if (sig.toString('base64url') !== signature || !verify(null, Buffer.from(`${DOMAIN}${canonicalize(p)}`), key, sig)) fail('seller_state_corrupt');
      return clone(p.body);
    } catch { fail('seller_state_corrupt'); }
  }
  try {
    const config = get('SELECT value FROM seller_meta WHERE key=?', 'context');
    if (config) verified(config.value, 'context', 'context');
    else if (get('SELECT COUNT(*) AS n FROM seller_jobs').n || get('SELECT COUNT(*) AS n FROM seller_effects').n || get('SELECT COUNT(*) AS n FROM seller_settlements').n) fail('seller_state_corrupt');
    const fencedStore = await createFsFencedSessionStore({ dir: join(dir, 'sdk-agreements') });
    const receiptStore = await createFsSellerReceiptStore({ dir: join(dir, 'sdk-receipts') });
    function load(jobId) {
      const row = get('SELECT * FROM seller_jobs WHERE job=?', jobId);
      if (!row) return null;
      const stored = verified(row.value, 'session', jobId);
      if (stored.revision !== row.revision || stored.session.jobId !== jobId || !isCanonicalJobId(jobId)) fail('seller_state_corrupt');
      return stored;
    }
    function effect(id) {
      const row = get('SELECT value FROM seller_effects WHERE id=?', id);
      return row ? verified(row.value, 'effect', id) : null;
    }
    function putEffect(id, value) { run('INSERT INTO seller_effects VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', id, authenticated('effect', id, value)); }
    const api = {
      fencedStore,
      receiptStore,
      context: () => {
        const row = get('SELECT value FROM seller_meta WHERE key=?', 'context');
        return row ? verified(row.value, 'context', 'context') : null;
      },
      retainContext(context) {
        transaction(() => {
          const row = get('SELECT value FROM seller_meta WHERE key=?', 'context');
          if (row) { if (!same(verified(row.value, 'context', 'context'), context)) fail('seller_state_context_conflict'); }
          else run('INSERT INTO seller_meta VALUES (?,?)', 'context', authenticated('context', 'context', context));
        });
      },
      sessions: () => db.prepare('SELECT job FROM seller_jobs ORDER BY job').all().map(({ job }) => load(job).session),
      loadSession: (jobId) => load(jobId)?.session ?? null,
      saveSession(session) {
        const jobId = session.jobId;
        const expected = owned.get(jobId);
        if (expected === undefined || get('SELECT owner FROM seller_locks WHERE job=?', jobId)?.owner !== owner) fail('seller_state_fenced');
        transaction(() => {
          const previous = load(jobId);
          if ((previous?.revision ?? 0) !== expected) fail('seller_state_fenced');
          if (!previous && get('SELECT COUNT(*) AS n FROM seller_jobs').n >= maxJobs) fail('seller_state_capacity');
          const revision = expected + 1;
          const value = authenticated('session', jobId, { revision, session });
          run('INSERT INTO seller_jobs VALUES (?,?,?) ON CONFLICT(job) DO UPDATE SET revision=excluded.revision,value=excluded.value', jobId, revision, value);
          owned.set(jobId, revision);
        });
      },
      async withJob(jobId, action) {
        if (!isCanonicalJobId(jobId)) fail('seller_state_job_invalid');
        transaction(() => {
          const lock = get('SELECT * FROM seller_locks WHERE job=?', jobId);
          if (lock) {
            // Never reclaim a live process by age. PID reuse also holds closed.
            let alive = true;
            try { process.kill(lock.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
            if (alive) fail('seller_state_busy');
            run('DELETE FROM seller_locks WHERE job=? AND owner=?', jobId, lock.owner);
          }
          run('INSERT INTO seller_locks VALUES (?,?,?)', jobId, owner, process.pid);
          owned.set(jobId, load(jobId)?.revision ?? 0);
        });
        try { return await action(load(jobId)?.session ?? null); } finally {
          run('DELETE FROM seller_locks WHERE job=? AND owner=?', jobId, owner);
          owned.delete(jobId);
        }
      },
      reserveSignatureCommitment(buyer, jobId) {
        return transaction(() => {
          const id = `signature-buyer:${buyer}`, prior = effect(id);
          if (prior?.pending && prior.jobId !== jobId) fail('seller_signature_buyer_unresolved');
          putEffect(id, { kind: 'signature-buyer', pending: true, jobId });
        });
      },
      releaseSignatureCommitment(buyer, jobId) {
        transaction(() => {
          const id = `signature-buyer:${buyer}`, prior = effect(id);
          if (prior?.pending && prior.jobId === jobId) putEffect(id, { ...prior, pending: false });
        });
      },
      bindSettlement(settlementId, jobId) {
        if (typeof settlementId !== 'string' || settlementId.length < 1 || settlementId.length > 512 || !isCanonicalJobId(jobId)) fail('seller_state_binding_invalid');
        return transaction(() => {
          const row = get('SELECT * FROM seller_settlements WHERE id=?', settlementId);
          const previous = row ? verified(row.value, 'settlement', settlementId) : null;
          if (previous && previous.job !== jobId) return false;
          if (previous && row.job !== previous.job) fail('seller_state_corrupt');
          if (!previous) run('INSERT INTO seller_settlements VALUES (?,?,?)', settlementId, jobId, authenticated('settlement', settlementId, { job: jobId }));
          return true;
        });
      },
      settlementJob(settlementId) {
        const row = get('SELECT * FROM seller_settlements WHERE id=?', settlementId);
        if (!row) return null;
        const retained = verified(row.value, 'settlement', settlementId);
        if (row.job !== retained.job) fail('seller_state_corrupt');
        return retained.job;
      },
      signOnce(id, bytes) {
        const bytesHash = sha256Hex(bytes);
        return transaction(() => {
          const prior = effect(id);
          if (prior) {
            if (prior.kind !== 'signature' || prior.bytesHash !== bytesHash) fail('seller_effect_conflict');
            if (prior.state !== 'complete') fail('seller_signature_reconciliation_required');
            const signature = Buffer.from(prior.signature, 'base64url');
            if (!verify(null, Buffer.from(bytes), key, signature)) fail('seller_state_corrupt');
            return signature;
          }
          // Retain the intent in a separate durable transaction before signing.
          return null;
        }) ?? (() => {
          transaction(() => {
            if (effect(id)) fail('seller_state_busy');
            putEffect(id, { kind: 'signature', bytesHash, state: 'intent' });
          });
          const signature = Buffer.from(signer.sign(Buffer.from(bytes)));
          if (signature.length !== 64 || !verify(null, Buffer.from(bytes), key, signature)) fail('seller_state_signer_invalid');
          transaction(() => putEffect(id, { kind: 'signature', bytesHash, state: 'complete', signature: signature.toString('base64url') }));
          return signature;
        })();
      },
      signature(id) {
        const prior = effect(id);
        if (!prior) return { disposition: 'absent', reason: 'no retained signing intent' };
        if (prior.kind !== 'signature' || prior.state !== 'complete') return { disposition: 'indeterminate', reason: 'retained signer outcome is unknown' };
        return { disposition: 'present', value: prior.signature };
      },
      async anchor({ jobId, logicalAddress, artifact, anchors, authorize }) {
        const id = `anchor:${logicalAddress}`;
        const value = { kind: 'anchor', jobId, logicalAddress, artifact: clone(artifact), hash: contentHash(artifact) };
        const perform = transaction(() => {
          const prior = effect(id);
          if (prior) {
            const { state, receipt, ...binding } = prior;
            if (!same(binding, value)) fail('seller_effect_conflict');
            return false;
          }
          putEffect(id, { ...value, state: 'intent' });
          return true;
        });
        if (perform) {
          let receipt;
          try { receipt = await anchors.write({ logicalAddress, artifact, writer: signer.claim, writerSignature: authorize() }); } catch { fail('seller_anchor_reconciliation_required'); }
          const record = { status: 'present', artifact, receipt };
          if (verifyFixtureRecord(record, { logicalAddress, expectedWriter: signer.claim }) !== 'valid') fail('seller_anchor_reconciliation_required');
          transaction(() => putEffect(id, { ...value, state: 'complete', receipt }));
          return receipt;
        }
        // A signed state snapshot is historical context, not anchor proof. Both
        // completed and uncertain anchors must be read and authenticated again.
        return api.reconcileAnchor(id, anchors);
      },
      async reconcileAnchor(id, anchors) {
        const prior = effect(id);
        if (!prior || prior.kind !== 'anchor') fail('seller_effect_missing');
        let record;
        try { record = await anchors.read(prior.logicalAddress); } catch { fail('seller_anchor_reconciliation_required'); }
        if (record.status !== 'present') fail('seller_anchor_reconciliation_required');
        if (!same(record.artifact, prior.artifact) || verifyFixtureRecord(record, { logicalAddress: prior.logicalAddress, expectedWriter: signer.claim }) !== 'valid') fail('seller_anchor_reconciliation_invalid');
        transaction(() => putEffect(id, { ...prior, state: 'complete', receipt: record.receipt }));
        return record.receipt;
      },
      hasAnchor: (logicalAddress) => effect(`anchor:${logicalAddress}`)?.kind === 'anchor',
      async readAnchor({ jobId, logicalAddress, anchors }) {
        const prior = effect(`anchor:${logicalAddress}`);
        if (!prior || prior.kind !== 'anchor' || prior.jobId !== jobId) fail('seller_anchor_intent_missing');
        const receipt = await api.reconcileAnchor(`anchor:${logicalAddress}`, anchors);
        return { status: 'present', artifact: clone(prior.artifact), receipt };
      },
      async reconcileJob(jobId, anchors) {
        const rows = db.prepare('SELECT id,value FROM seller_effects ORDER BY id').all();
        const outcomes = [];
        for (const row of rows) {
          const retained = verified(row.value, 'effect', row.id);
          if (retained.kind !== 'anchor' || retained.jobId !== jobId || retained.state === 'complete') continue;
          try { await api.reconcileAnchor(row.id, anchors); outcomes.push({ address: retained.logicalAddress, status: 'present-authenticated' }); }
          catch (error) { outcomes.push({ address: retained.logicalAddress, status: 'held', reason: error.code }); }
        }
        return { status: outcomes.some((v) => v.status === 'held') ? 'held' : 'reconciled', outcomes };
      },
      close: () => { if (owned.size) fail('seller_state_busy'); db.close(); },
    };
    return api;
  } catch (error) { db.close(); throw error; }
}
