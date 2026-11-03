import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SELLER_POLICY_MAX_WRITES, SELLER_POLICY_WINDOW_MS, sellerApprovalSettings } from '../src/devnet-demo/operator-approval.mjs';

// The follow-up table is the contract later request-wiring PRs are reviewed against.
const doc = readFileSync(new URL('../docs/SERVICE-REQUEST-BINDING.md', import.meta.url), 'utf8');
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const rowsOf = (text, order) => text.split('\n').filter((line) => line.startsWith(`| ${order} |`));
const row = (order, text = doc) => {
  const rows = rowsOf(text, order);
  assert.equal(rows.length, 1, `one follow-up row for ${order}`);
  return rows[0];
};

test('result feasibility is required before the first Agreement signature and again before payment', () => {
  for (const order of ['8c', '8e (showcase 9)']) {
    const required = row(order);
    assert.match(required, /before the first Agreement signature and again before payment submission/, order);
    assert.match(required, /zero Agreement signatures, broadcasts and payment submissions/, order);
  }
  const producer = row('8e (showcase 9)');
  assert.match(producer, /complete result, signed storage envelope, Deliverable CREATE and relay request/);
  assert.match(producer, /retain the write-preparation checks/);
  assert.match(doc, /\*\*Result feasibility precedes Agreement signatures and payment\.\*\*/);
});

test('every result-side chain write has its own lost-response and restart recovery tests', () => {
  const acceptance = row('8f');
  for (const write of ['native Deliverable CREATE', 'delivery SettlementEvidence CREATE']) {
    assert.match(acceptance, new RegExp(`${write}: separate lost-response and restart tests`), write);
  }
  assert.match(acceptance, /exact send count stays one/);
  assert.match(acceptance, /unresolved outcome stays unknown and readback-only/);
});

const feasibility = (text = doc) => text.split('\n').find((line) => line.startsWith('**Result feasibility precedes'));
const checkpoints = () => [feasibility(), row('8c'), row('8e (showcase 9)')];

// Each check below returns its problems instead of asserting, so the witness
// tests can run the same check against a mutated document or source file.
const once = (text, before, after) => {
  assert.equal(text.split(before).length, 2, `one mutation site for ${before}`);
  return text.replace(before, after);
};
const mutateDoc = (before, after) => ({ text: once(doc, before, after), readSource: read });
const mutateSource = (file, before, after) => {
  const changed = once(read(file), before, after);
  return { text: doc, readSource: (path) => (path === file ? changed : read(path)) };
};

// Hook citations name a function; a line number goes stale silently.
const HOOK = /^((?:src|public)(?:\/[\w-]+)+\.(?:mjs|js))#([A-Za-z_$][\w$]*)\(\)$/;
const PATH = /^(?:src|public)(?:\/[\w-]+)+\.(?:mjs|js|json)$/;
const declaration = (name) => new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(|^\\s*(?:export\\s+)?(?:const|let)\\s+${name}\\s*=\\s*(?:async\\s*)?\\([^;]*?\\)\\s*=>`, 'm');
function citationProblems(text, readSource) {
  const problems = [];
  for (const match of text.matchAll(/(?:src|public)\/[^\s`)]*?(?:\.(?:mjs|js):\d+|#L\d+)|\blines? \d+/g)) problems.push(`line citation: ${match[0]}`);
  for (const [, span] of text.matchAll(/`([^`\n]+)`/g)) {
    if (!/(?:^|[^\w./-])(?:src|public)\//.test(span)) continue;
    if (!/^(?:src|public)\//.test(span)) { problems.push(`source reference must be the whole code span: ${span}`); continue; }
    if (!span.includes('#')) { if (!PATH.test(span)) problems.push(`malformed source path: ${span}`); continue; }
    const hook = HOOK.exec(span);
    if (!hook) { problems.push(`hook citation is not path#function(): ${span}`); continue; }
    let source;
    try { source = readSource(hook[1]); } catch { problems.push(`cited file is missing: ${span}`); continue; }
    // Check declarations, not imports, calls or comments mentioning the function.
    if (!declaration(hook[2]).test(source)) problems.push(`cited function is not declared in its file: ${span}`);
  }
  return problems;
}

test('every backticked source reference is a path or a path#function() hook declared in its file', () => {
  assert.deepEqual(citationProblems(doc, read), []);
  const hooks = [...doc.matchAll(/`((?:src|public)\/[^`#]+)#(\w+)\(\)`/g)];
  for (const [file, name] of [
    ['src/dacs/verification.mjs', 'verify'],
    ['src/dacs/protocol-purchases.mjs', 'planRequest'],
    ['src/dacs/protocol-purchases.mjs', 'signRequest'],
    ['src/dacs/purchase-protocol.mjs', 'boundTermsMismatch'],
    ['public/portal/portal.js', 'termsRows'],
    ['public/portal/portal.js', 'signAgreement'],
    ['public/portal/portal.js', 'walletSign'],
  ]) assert.ok(hooks.some(([, path, fn]) => path === file && fn === name), `${file}#${name}()`);
});

const LISTING_HOOK = 'src/dacs/listing.mjs#buildListingDraft()';
for (const [name, after, problem] of [
  ['#L line anchor', 'src/dacs/listing.mjs#L96', /line citation/],
  ['#L line range', 'src/dacs/listing.mjs#L96-L120', /line citation/],
  ['colon line suffix', 'src/dacs/listing.mjs:96', /line citation/],
  ['numeric hook name', 'src/dacs/listing.mjs#96()', /not path#function\(\)/],
  ['hook without parentheses', 'src/dacs/listing.mjs#buildListingDraft', /not path#function\(\)/],
  ['function absent from its file', 'src/dacs/listing.mjs#buildListingDraftV2()', /not declared/],
  ['missing cited file', 'src/dacs/listings.mjs#buildListingDraft()', /file is missing/],
  ['reference inside a longer span', 'see src/dacs/listing.mjs', /whole code span/],
]) test(`citation witness: ${name} is refused`, (t) => {
  const { text, readSource } = mutateDoc(LISTING_HOOK, after), problems = citationProblems(text, readSource);
  t.diagnostic(problems.join('; '));
  assert.ok(problems.some((found) => problem.test(found)), `${after} must be refused`);
});

// Seller write limits as the code applies them. A value the code no longer
// states in the expected form reads as null, which never matches the document.
const APPROVAL = 'src/devnet-demo/operator-approval.mjs', WALLET = 'public/portal/embedded-wallet/sdk-provider.mjs', OPERATOR = 'src/devnet-demo/operator.mjs';
const OS_PER_DEM = 1_000_000_000n;
const integer = (digits) => (digits == null ? null : BigInt(digits.replaceAll('_', '')));
const body = (source, name) => {
  const start = source.search(new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm'));
  const end = start < 0 ? -1 : source.indexOf('\n}', start);
  return end < 0 ? '' : source.slice(start, end + 2);
};
function codeLimits(readSource) {
  const approval = readSource(APPROVAL), wallet = readSource(WALLET), operator = readSource(OPERATOR);
  const policy = body(approval, 'policyRefusal'), budget = body(approval, 'budgetRefusal'), settings = body(approval, 'sellerApprovalSettings');
  const plan = body(wallet, 'devnetAgreementAnchorPlan'), debit = body(wallet, 'nativeDebit');
  let defaults = null;
  try {
    const literal = /SELLER_POLICY_DEFAULTS\s*=\s*Object\.freeze\((\{[^}]*\})\)/.exec(approval)?.[1];
    defaults = literal ? JSON.parse(literal.replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":').replaceAll("'", '"')) : null;
  } catch { defaults = null; }
  const policyChunk = /Math\.max\(\s*1\s*,\s*Math\.ceil\(\s*c\.storageBytes\s*\/\s*([\d_]+)\s*\)\s*\)\s*\)\s*\*\s*([\d_]+)n/.exec(policy);
  const osPerDem = integer(/const OS_PER_DEM\s*=\s*([\d_]+)n\s*;/.exec(wallet)?.[1]);
  const walletChunkSized = /Math\.max\(\s*1\s*,\s*Math\.ceil\(\s*storageBytes\s*\/\s*STORAGE_CHUNK_BYTES\s*\)\s*\)\s*\)\s*\*\s*OS_PER_DEM/.test(plan);
  const gas = /const SDK_GAS_OS\s*=\s*(?:OS_PER_DEM|([\d_]+)n)\s*;/.exec(wallet);
  const wired = (text, pattern) => pattern.test(text);
  return {
    chunkBytes: [integer(policyChunk?.[1]), walletChunkSized ? integer(/const STORAGE_CHUNK_BYTES\s*=\s*([\d_]+)\s*;/.exec(wallet)?.[1]) : null],
    chunkFeeOs: [integer(policyChunk?.[2]), walletChunkSized ? osPerDem : null],
    sdkGasOs: gas && wired(debit, /SDK_GAS_OS\s*\+\s*networkFeeOs\s*\+\s*rpcFeeOs/) ? (gas[1] ? integer(gas[1]) : osPerDem) : null,
    maxWriteTotalOs: wired(settings, /\.\.\.SELLER_POLICY_DEFAULTS/) && wired(policy, /cap\s*=\s*BigInt\(limits\.maxWriteTotalOs\)/) && wired(policy, /return\s*'write-fee-cap'/) ? integer(defaults?.maxWriteTotalOs) : null,
    maxWritesPerJob: wired(budget, />=\s*SELLER_POLICY_MAX_WRITES\s*\)\s*return\s*'job-write-limit'/) ? integer(/export const SELLER_POLICY_MAX_WRITES\s*=\s*([\d_]+)\s*;/.exec(approval)?.[1]) : null,
    maxWritesPerHour: wired(budget, />=\s*limits\.maxWritesPerHour\s*\)\s*return\s*'hourly-write-limit'/) && Number.isSafeInteger(defaults?.maxWritesPerHour) ? BigInt(defaults.maxWritesPerHour) : null,
    maxTotalOsPerHour: wired(budget, />\s*BigInt\(limits\.maxTotalOsPerHour\)\s*\)\s*return\s*'hourly-dem-limit'/) ? integer(defaults?.maxTotalOsPerHour) : null,
    windowMs: wired(budget, /at\s*-\s*SELLER_POLICY_WINDOW_MS/) ? integer(/export const SELLER_POLICY_WINDOW_MS\s*=\s*([\d_]+)\s*;/.exec(approval)?.[1]) : null,
    sellerFeeBudgetRequired: wired(body(operator, 'validateConfig'), /exact\(value\.sellerFeeBudget,\s*\['maxTotalOs'\]\)/),
  };
}

// [table key, code value, unit, functions the row must cite]
const LIMIT_ROWS = (code, chunkBytes) => [
  ['STORAGE_CHUNK_BYTES', chunkBytes, 'bytes', ['policyRefusal', 'devnetAgreementAnchorPlan']],
  ['maxWriteTotalOs', code.maxWriteTotalOs, 'DEM', ['sellerApprovalSettings', 'policyRefusal']],
  ['SELLER_POLICY_MAX_WRITES', code.maxWritesPerJob, '', ['budgetRefusal']],
  ['maxWritesPerHour', code.maxWritesPerHour, '', ['sellerApprovalSettings', 'budgetRefusal']],
  ['maxTotalOsPerHour', code.maxTotalOsPerHour, 'DEM', ['sellerApprovalSettings', 'budgetRefusal']],
  ['SELLER_POLICY_WINDOW_MS', code.windowMs, 'ms', ['budgetRefusal']],
];
const cells = (line) => line.split('|').slice(1, -1).map((cell) => cell.trim());
function limitProblems(text, readSource) {
  const code = codeLimits(readSource), problems = [];
  const unreadable = (label) => problems.push(`${label}: the code no longer states this limit in the form the test reads`);
  // The operator policy and the wallet size storage separately; both must agree. undefined = already reported.
  const agreed = (label, [operator, wallet]) => {
    if (operator === null || wallet === null) return void unreadable(label);
    if (operator !== wallet) return void problems.push(`${label}: operator ${operator} and wallet ${wallet} differ`);
    return operator;
  };
  const table = text.split('\n').filter((line) => line.startsWith('|')).map(cells);
  const limitRow = (key) => {
    const found = table.filter((columns) => columns[0]?.includes(`\`${key}\``));
    if (found.length !== 1) problems.push(`${key}: expected one limits table row, found ${found.length}`);
    return found.length === 1 ? found[0] : null;
  };
  for (const [key, value, unit, functions] of LIMIT_ROWS(code, agreed('STORAGE_CHUNK_BYTES', code.chunkBytes))) {
    const columns = limitRow(key);
    if (!columns) continue;
    const number = /(\d[\d,]*)\s*(bytes|DEM|ms)?/.exec(columns[1] ?? '');
    const documented = number ? BigInt(number[1].replaceAll(',', '')) * (unit === 'DEM' ? OS_PER_DEM : 1n) : null;
    if (value === null) unreadable(key);
    else if (value !== undefined && (documented !== value || (number?.[2] ?? '') !== unit)) problems.push(`${key}: documented ${columns[1]}, code ${unit === 'DEM' ? `${value / OS_PER_DEM} DEM (${value} OS)` : `${value} ${unit}`.trim()}`);
    for (const name of functions) if (!columns[2]?.includes(`#${name}()`)) problems.push(`${key}: row must cite ${name}()`);
  }
  const chunk = limitRow('STORAGE_CHUNK_BYTES'), chunkFeeOs = agreed('storage chunk fee (OS)', code.chunkFeeOs);
  const chunkFee = /(\d+) DEM per started chunk/.exec(chunk?.[1] ?? '');
  if (chunkFeeOs !== undefined && (!chunkFee || BigInt(chunkFee[1]) * OS_PER_DEM !== chunkFeeOs)) problems.push(`storage chunk fee: documented ${chunk?.[1]}, code ${chunkFeeOs} OS per chunk`);
  const budget = limitRow('sellerFeeBudget.maxTotalOs');
  if (!code.sellerFeeBudgetRequired) problems.push('sellerFeeBudget.maxTotalOs: validateConfig() no longer requires it');
  else if (budget && (!/no default/i.test(budget[1]) || !budget[2].includes('#validateConfig()'))) problems.push('sellerFeeBudget.maxTotalOs: row must say it has no default and cite validateConfig()');
  return problems;
}

test('the seller write limits table equals the effective defaults in code', () => {
  assert.deepEqual(limitProblems(doc, read), []);
});

test('limits read from the source equal the values the module applies at runtime', () => {
  const code = codeLimits(read), effective = sellerApprovalSettings({ mode: 'policy' });
  assert.equal(code.maxWriteTotalOs, BigInt(effective.maxWriteTotalOs));
  assert.equal(code.maxWritesPerHour, BigInt(effective.maxWritesPerHour));
  assert.equal(code.maxTotalOsPerHour, BigInt(effective.maxTotalOsPerHour));
  assert.equal(code.maxWritesPerJob, BigInt(SELLER_POLICY_MAX_WRITES));
  assert.equal(code.windowMs, BigInt(SELLER_POLICY_WINDOW_MS));
  // The chunk size has no runtime export; both copies must read and agree.
  assert.ok(code.chunkBytes[0] !== null && code.chunkBytes[0] === code.chunkBytes[1]);
  assert.equal(code.sellerFeeBudgetRequired, true);
});

for (const [name, mutate] of [
  ['8,192-byte operator chunk', () => mutateSource(APPROVAL, 'Math.ceil(c.storageBytes/10240)', 'Math.ceil(c.storageBytes/8192)')],
  ['8,192-byte wallet chunk', () => mutateSource(WALLET, 'const STORAGE_CHUNK_BYTES = 10240;', 'const STORAGE_CHUNK_BYTES = 8192;')],
  ['2 DEM per operator chunk', () => mutateSource(APPROVAL, 'Math.ceil(c.storageBytes/10240)))*1_000_000_000n', 'Math.ceil(c.storageBytes/10240)))*2_000_000_000n')],
  ['5 DEM per-write cap', () => mutateSource(APPROVAL, "maxWriteTotalOs:'4000000000'", "maxWriteTotalOs:'5000000000'")],
  ['seven writes per job', () => mutateSource(APPROVAL, 'SELLER_POLICY_MAX_WRITES=6;', 'SELLER_POLICY_MAX_WRITES=7;')],
  ['30 writes per hour', () => mutateSource(APPROVAL, 'maxWritesPerHour:24', 'maxWritesPerHour:30')],
  ['120 DEM per hour', () => mutateSource(APPROVAL, "maxTotalOsPerHour:'96000000000'", "maxTotalOsPerHour:'120000000000'")],
  ['two-hour window', () => mutateSource(APPROVAL, 'SELLER_POLICY_WINDOW_MS=3_600_000;', 'SELLER_POLICY_WINDOW_MS=7_200_000;')],
  ['job limit no longer enforced', () => mutateSource(APPROVAL, ">=SELLER_POLICY_MAX_WRITES)return 'job-write-limit'", ">SELLER_POLICY_MAX_WRITES+1)return 'job-write-limit'")],
  ['seller fee budget no longer required', () => mutateSource(OPERATOR, "exact(value.sellerFeeBudget,['maxTotalOs'])", "exact(value.sellerFeeBudget??{maxTotalOs:'1'},['maxTotalOs'])")],
  ['document states a 5 DEM cap', () => mutateDoc('| Per-write fee cap (`maxWriteTotalOs`) | 4 DEM |', '| Per-write fee cap (`maxWriteTotalOs`) | 5 DEM |')],
  ['document drops the job limit row', () => mutateDoc('| Seller writes per job (`SELLER_POLICY_MAX_WRITES`) |', '| Seller writes per job |')],
]) test(`limit witness: ${name} is caught`, (t) => {
  const { text, readSource } = mutate(), problems = limitProblems(text, readSource);
  t.diagnostic(problems.join('; '));
  assert.notDeepEqual(problems, []);
});

test('result feasibility includes storage chunks, per-write fees and seller write budgets', () => {
  for (const required of [feasibility(), row('8e (showcase 9)')]) {
    assert.match(required, /storage-chunk count.*max\(1, ceil\(storageBytes \/ chunk size\)\).*per started chunk/);
    assert.match(required, /`maxWriteTotalOs`.*`write-fee-cap`/);
    assert.match(required, /`sellerFeeBudget\.maxTotalOs`/);
    assert.match(required, /per-job seller write limit/);
    assert.match(required, /`maxWritesPerHour`.*`maxTotalOsPerHour`.*rolling hour/);
    assert.match(required, /remaining.*budget.*outstanding.*unknown.*reservations/);
    assert.match(required, /before the first Agreement signature/);
  }
});

// Fee totals depend on the node's current network and RPC fees, so any stated
// total names the fees it assumes and its arithmetic matches the code.
const sentences = (text) => text.split(/(?<=[.;])\s+|\n/);
function feeProblems(text, readSource) {
  const code = codeLimits(readSource), problems = [];
  for (const [label, required] of [['feasibility paragraph', feasibility(text)], ['8e row', rowsOf(text, '8e (showcase 9)')[0]]]) {
    for (const pattern of [/both check points/, /admitted current network and RPC fees/, /conservative bound the operator has authori[sz]ed/]) {
      if (!pattern.test(required ?? '')) problems.push(`${label} must require ${pattern.source}`);
    }
  }
  let example = false;
  for (const sentence of sentences(text)) {
    const claims = [...sentence.matchAll(/\b(one|two|second) (?:storage )?chunks? (?:totals?|costs?) (\d+) DEM(?: and (fits|passes|pass|refuses|refuse))?/g)];
    const stated = /\b\d+ DEM\b/.test(sentence) && /chunk/.test(sentence) && /\b(?:totals?|costs?)\b/.test(sentence);
    const fees = /network = RPC = (\d+) DEM/.exec(sentence) ?? /network (\d+) and RPC (\d+) DEM/.exec(sentence);
    if (!fees) { if (stated || claims.length) problems.push(`fee total without its network and RPC fee assumption: ${sentence}`); continue; }
    const [network, rpc] = [BigInt(fees[1]), BigInt(fees[2] ?? fees[1])];
    if (/example/i.test(sentence) && network === 1n && rpc === 1n && claims.length) example = true;
    for (const [claim, count, total, outcome] of claims) {
      if (code.chunkFeeOs[0] === null || code.sdkGasOs === null || code.maxWriteTotalOs === null) { problems.push('fee example: the code no longer states chunk fee, SDK gas or cap in the form the test reads'); break; }
      const chunks = count === 'one' ? 1n : 2n, computed = chunks * code.chunkFeeOs[0] + code.sdkGasOs + (network + rpc) * OS_PER_DEM;
      if (BigInt(total) * OS_PER_DEM !== computed) problems.push(`fee example "${claim}": code totals ${computed / OS_PER_DEM} DEM`);
      if (outcome && /^refuse/.test(outcome) !== computed > code.maxWriteTotalOs) problems.push(`fee example "${claim}": the default cap ${code.maxWriteTotalOs / OS_PER_DEM} DEM decides otherwise`);
    }
  }
  if (!example) problems.push('the fee totals must be labelled as an example assuming network = RPC = 1 DEM');
  return problems;
}

test('fee totals are labelled examples and both check points use admitted current fees or an authorized bound', () => {
  assert.deepEqual(feeProblems(doc, read), []);
});

for (const [name, mutate] of [
  ['unconditional second-chunk cost', () => mutateDoc('(refusal `write-fee-cap`)', '(default 4 DEM: one storage chunk plus 1 DEM each for SDK gas, network and RPC; a second chunk costs 5 DEM and refuses with `write-fee-cap`)')],
  ['example without its fee assumption', () => mutateDoc('Example, assuming network = RPC = 1 DEM: one', 'Example: one')],
  ['8e row without current fees', () => mutateDoc('At both check points, compute each debit from the admitted current network and RPC fees, or from a conservative bound the operator has authorized; the 4 and 5', 'The 4 and 5')],
  ['feasibility paragraph without current fees', () => mutateDoc("At both check points, compute each write's debit from the admitted current network and RPC fees, or from a conservative bound the operator has authorized; a", 'A')],
  ['wrong example total', () => mutateDoc('two chunks total 5 DEM and refuse', 'two chunks total 6 DEM and refuse')],
  ['wrong counterexample outcome', () => mutateDoc('two chunks total 4 DEM and pass', 'two chunks total 4 DEM and refuse')],
  ['SDK gas of 2 DEM', () => mutateSource(WALLET, 'const SDK_GAS_OS = OS_PER_DEM;', 'const SDK_GAS_OS = 2_000_000_000n;')],
]) test(`fee witness: ${name} is caught`, (t) => {
  const { text, readSource } = mutate(), problems = feeProblems(text, readSource);
  t.diagnostic(problems.join('; '));
  assert.notDeepEqual(problems, []);
});

test('a failed or unavailable pre-signature check permits no signatures, broadcasts or payments', () => {
  for (const required of checkpoints()) assert.match(required, /failed or unavailable check before the first Agreement signature.*zero Agreement signatures, broadcasts and payment submissions/);
});

test('a failed or unavailable pre-payment check holds the signed Agreement non-payable for readback only', () => {
  for (const required of checkpoints()) {
    assert.match(required, /failed or unavailable check before payment.*zero payment submissions and no further broadcasts/);
    assert.match(required, /signed Agreement.*explicit non-payable state for readback only, never resent/);
  }
});

test('a failed or unavailable write-preparation check follows 8f recovery rules', () => {
  for (const required of checkpoints()) assert.match(required, /failed or unavailable check at write preparation follows the recovery rules in (?:the )?8f row/);
  const acceptance = row('8f');
  assert.match(acceptance, /failure before a CREATE intent.*zero sends/);
  assert.match(acceptance, /retained intent.*never resent/);
  assert.match(acceptance, /unresolved outcome stays unknown and readback-only/);
});
