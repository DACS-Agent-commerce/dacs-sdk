// Closure (identity recovery): wrong-implementation witnesses. One bounded
// contract check (recoveryViolations) runs against the shipped
// src/identities.mjs, where it must find nothing, and against disposable
// mutated copies written to a temporary directory, where it must name the
// broken rule. The candidate source is never modified. Plain offline state
// machine: in-memory SQLite, controllable clock, fixture chain object. Not a
// security review.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../src/store/database.mjs';
import { createAccountService } from '../src/accounts.mjs';
import { createOperationStore } from '../src/operations.mjs';
import { createCoordinateStore } from '../src/dacs/wallet-transactions.mjs';
import * as shipped from '../src/identities.mjs';

const SRC = new URL('../src/', import.meta.url);
const ORIGINAL = readFileSync(new URL('identities.mjs', SRC), 'utf8');
const DACS_IDENTITY = import.meta.resolve('@kynesyslabs/dacs/identity');

// Each mutant reproduces one plausible wrong repair and names the contract
// rule recoveryViolations must report for it.
const MUTANTS = [
  {
    name: 'pre-repair behaviour: embedded pre-send failures stay unknown (stranding)',
    find: "    if (outcome?.wallet === 'embedded' && EMBEDDED_STOPPED_BEFORE_SEND.has(outcome?.code)) return 'failed_before_send';\n",
    replace: '',
    expect: ['pre-send closes', 'pre-send frees wallet'],
  },
  {
    name: 'every embedded failure treated as pre-send (ambiguous called closed)',
    find: "EMBEDDED_STOPPED_BEFORE_SEND.has(outcome?.code)) return 'failed_before_send'",
    replace: "typeof outcome?.code === 'string') return 'failed_before_send'",
    expect: ['ambiguous stays unknown', 'ambiguous keeps wallet blocked'],
  },
  {
    name: 'wallet marker ignored (extension codes closed)',
    find: "if (outcome?.wallet === 'embedded' && EMBEDDED_STOPPED_BEFORE_SEND",
    replace: 'if (EMBEDDED_STOPPED_BEFORE_SEND',
    expect: ['extension stays unknown'],
  },
  {
    name: 'closed actions still counted in flight',
    find: "const IN_FLIGHT = new Set([...OPEN_STATUSES, 'wallet_requested', 'readback_pending', 'outcome_unknown']);",
    replace: "const IN_FLIGHT = new Set([...OPEN_STATUSES, 'wallet_requested', 'readback_pending', 'outcome_unknown', 'failed_before_send', 'cancelled']);",
    expect: ['pre-send frees wallet', 'cancel frees wallet'],
  },
  {
    name: 'cancel allowed after the wallet was asked',
    find: '    if (!OPEN_STATUSES.has(operation.status)) {\n',
    replace: '    if (false) {\n',
    expect: ['no cancel after asking'],
  },
  {
    name: 'GitHub proof-step check removed',
    find: "  if (kind === 'github' && !GITHUB_HANDLE.test(parts[0])) {\n",
    replace: '  if (false) {\n',
    expect: ['impossible GitHub handle refused at proof step'],
  },
];

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dacs-closure-witness-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

// Writes a copy whose imports point at the real modules, so only the mutated
// lines differ from the shipped file.
async function loadCopy(label, mutant) {
  let text = ORIGINAL;
  if (mutant) {
    assert.equal(text.split(mutant.find).length, 2, `mutation anchor appears exactly once: ${mutant.name}`);
    text = text.replace(mutant.find, () => mutant.replace);
  }
  text = text
    .replace(/from '\.\/([^']+)'/g, (_, p) => `from '${new URL(p, SRC).href}'`)
    .replace("from '@kynesyslabs/dacs/identity'", () => `from '${DACS_IDENTITY}'`);
  const file = join(dir, `identities-${label}.mjs`);
  writeFileSync(file, text);
  return import(pathToFileURL(file).href);
}

// The recovery contract, independently of the implementation's own wording.
// Returns the names of the rules the given implementation breaks.
async function recoveryViolations({ createIdentityActions }) {
  const broken = [];
  const db = openDatabase(join(mkdtempSync(join(dir, 'db-')), 'db.sqlite'));
  try {
    const now = () => Date.parse('2026-10-04T00:00:00Z');
    const accounts = createAccountService({ db, builtinIssuer: 'https://issuer.invalid/oauth', now });
    const ops = createOperationStore({ db, handoffSecret: 'w'.repeat(40), now });
    const coordinates = createCoordinateStore({ db, now });
    const chain = { network: 'demos-testnet', evidenceMode: 'simulated-fixture', getIdentities: async () => ({ result: 200, response: { xm: {}, web2: {}, ud: [], pqc: {} } }) };
    const actions = createIdentityActions({ config: { identityWrites: 'simulated-fixture-only' }, ops, accounts, coordinates, chain, now });
    let n = 0;
    const fresh = () => {
      n += 1;
      const wallet = `0x${n.toString(16).padStart(64, '0')}`;
      return { wallet, account: accounts.loginWithWallet({ address: wallet, challengeId: `chl_w${n}` }) };
    };
    const startFor = async ({ account }, kind = 'twitter') => {
      n += 1;
      const s = await actions.start({ accountId: account.id, idempotencyKey: `wit-${n}-key`, action: 'add', kind });
      return { id: s.operation.id, token: s.handoffToken };
    };
    const toReview = async (who, proofUrl = 'https://x.com/witness_case/status/1') => {
      const ref = await startFor(who);
      await actions.opened(ref.id, ref.token);
      actions.connected({ ...ref, address: who.wallet });
      await actions.submitProof({ ...ref, proofUrl });
      return ref;
    };
    const nextAllowed = async (who) => {
      try {
        await startFor(who, 'github');
        return true;
      } catch (error) {
        if (error.code === 'identity_operation_in_progress') return false;
        throw error;
      }
    };
    const rule = async (name, fn) => {
      try {
        if (!(await fn())) broken.push(name);
      } catch (error) {
        broken.push(`${name} (threw ${error.code ?? error.message})`);
      }
    };
    const reportFresh = async (outcome) => {
      const who = fresh();
      const ref = await toReview(who);
      actions.request(ref);
      return { who, ref, status: (await actions.report({ ...ref, outcome })).operation.status };
    };

    const pre = await reportFresh({ success: false, code: 'upstream_unavailable', message: 'nothing was signed', wallet: 'embedded' });
    await rule('pre-send closes', () => pre.status === 'failed_before_send');
    await rule('pre-send frees wallet', () => nextAllowed(pre.who));

    const amb = await reportFresh({ success: false, code: 'outcome_unknown', message: 'may have reached the node', wallet: 'embedded' });
    await rule('ambiguous stays unknown', () => amb.status === 'readback_pending');
    await rule('ambiguous keeps wallet blocked', async () => !(await nextAllowed(amb.who)));

    const ext = await reportFresh({ success: false, code: 'upstream_unavailable', message: 'x', wallet: 'extension' });
    await rule('extension stays unknown', () => ext.status === 'readback_pending');

    const rej = await reportFresh({ success: false, code: 'USER_REJECTED', message: 'User rejected', wallet: 'extension' });
    await rule('user rejection unchanged', () => rej.status === 'rejected_before_send');

    const c = fresh();
    const cref = await toReview(c);
    await rule('cancel before asking', () => actions.cancel(cref).status === 'cancelled');
    await rule('cancel frees wallet', () => nextAllowed(c));

    const asked = fresh();
    const aref = await toReview(asked);
    actions.request(aref);
    await rule('no cancel after asking', () => {
      try {
        actions.cancel(aref);
        return false;
      } catch (error) {
        return error.code === 'invalid_state';
      }
    });

    const g = fresh();
    const gref = await startFor(g, 'github');
    await actions.opened(gref.id, gref.token);
    actions.connected({ ...gref, address: g.wallet });
    await rule('impossible GitHub handle refused at proof step', async () => {
      try {
        await actions.submitProof({ ...gref, proofUrl: 'https://gist.github.com/no_such/0123456789abcdef' });
        return false;
      } catch (error) {
        return error.code === 'invalid_proof_url' && actions.portalOperation(gref.id, gref.token).status === 'awaiting_public_proof';
      }
    });
  } finally {
    db.close();
  }
  return broken;
}

test('accepting control: the shipped module and its unmutated copy satisfy every recovery rule', async () => {
  assert.deepEqual(await recoveryViolations(shipped), []);
  assert.deepEqual(await recoveryViolations(await loadCopy('unmutated')), [], 'the copy loader itself changes nothing');
});

for (const [i, mutant] of MUTANTS.entries()) {
  test(`witness: "${mutant.name}" is caught`, async () => {
    const broken = await recoveryViolations(await loadCopy(`m${i}`, mutant));
    for (const name of mutant.expect) assert.ok(broken.some((b) => b === name || b.startsWith(`${name} (`)), `expected "${name}" in ${JSON.stringify(broken)}`);
  });
}
