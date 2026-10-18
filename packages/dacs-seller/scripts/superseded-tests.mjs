#!/usr/bin/env node
// Inventory copied-test references to D5-removed APIs, switches and app state.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
const names = text => new Set([...text.matchAll(/export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([\w$]+)/g)].map(m => m[1]).concat(
  [...text.matchAll(/export\s*\{([^}]*)\}/g)].flatMap(m => m[1].split(',').map(part => part.trim().split(/\s+as\s+/).pop()).filter(Boolean))));
const removed = new Set();
for (const file of walk(join(pkg, 'port-sources')).filter(p => p.includes('/src/') && p.endsWith('.mjs'))) {
  const target = join(pkg, 'src', file.split('/src/')[1]);
  const current = names(existsSync(target) ? readFileSync(target, 'utf8') : '');
  for (const name of names(readFileSync(file, 'utf8'))) if (!current.has(name)) removed.add(name);
}
const replaced = new Set([
  'test/seller-policy-purchase-source.test.mjs', 'test/seller-policy-purchase-source-node2.test.mjs',
  'test/fee-approval-recovery-offline.test.mjs', 'test/seller-policy-delivery-evidence.test.mjs',
  'test/seller-context-route.test.mjs', 'test/seller-context-route-unit.test.mjs',
  'test/seller-context-route-shutdown-resume.test.mjs', 'test/helpers/seller-context-fixture.mjs',
  'test/helpers/seller-context-off-scenario.mjs',
  'test/seller-policy-commit-on-signature.test.mjs', 'test/helpers/seller-context-off-operator.mjs',
  'test/devnet-buyer-access-prefixed.test.mjs',
]);
const hostOnly = new Set([
  'test/devnet-operator-seller-tls.test.mjs',
]);
const policyReview = new Map([
  ['test/closed-access-boundaries.test.mjs', 'D12: replace variable-mode implicit app policy wiring with seller records; preserve the refusal-only policy assertions and zero-effect closed-access checks. No automatic pre-payment approval is asserted here.'],
  ['test/closed-access-paid-recovery.test.mjs', 'D12: keep held-then-manual recovery; replace implicit app policy wiring with seller records and recheck the purchase policyReason at line 83. See the semantic note above.'],
  ['test/seller-policy-journal-freshness.test.mjs', 'D12: policy.purchaseSource explicitly selects seller at line 31; preserve journal freshness assertions when rehosting. The settings object alone does not select app state.'],
  ['test/seller-policy-reservation-restart.test.mjs', 'D12: policy.purchaseSource explicitly selects seller at line 94; preserve reservation/restart assertions when rehosting. The settings object alone does not select app state.'],
]);
const excluded = new Set(['test/ops-health.test.mjs', 'test/server-hosting.test.mjs']);
const signals = [
  ['removed export', new RegExp('\\b(' + [...removed].join('|') + ')\\b')],
  ['context switch', /DACS_SELLER_CONTEXT/], ['app source', /purchaseSource\s*:\s*['"]app['"]/], ['app harness state', /application\.db/],
];
const rows = [];
for (const file of walk(join(pkg, 'test')).filter(p => p.endsWith('.mjs') && !p.split('/').at(-1).startsWith('d5-')).sort()) {
  const path = file.slice(pkg.length + 1), text = readFileSync(file, 'utf8'), lines = text.split('\n');
  const hits = signals.flatMap(([label, pattern]) => {
    const at = lines.flatMap((line, i) => pattern.test(line) ? [i + 1] : []);
    return at.length ? [label + ' at ' + at.join(', ')] : [];
  });
  // Treat simple local approval configuration without an explicit seller source
  // as a review candidate, including variable-valued modes. Low-level tests
  // may select seller separately in policy.purchaseSource; say so in the row.
  const implicit = [...text.matchAll(/sellerApproval\s*:\s*\{[^{}]*\}/g)]
    .filter(match => !/purchaseSource\s*:\s*['"]seller['"]/.test(match[0]))
    .map(match => text.slice(0, match.index).split('\n').length);
  if (implicit.length) hits.push('seller approval without local seller source at ' + implicit.join(', '));
  // Artifact and approval assertions often occupy different lines. This is
  // deliberately a file-level candidate signal, not a semantic verdict.
  if (/\b(?:FinalityCommitmentRecord|PartyVet|CompositeVerificationRecord)\b/.test(text)) {
    const approvals = lines.flatMap((line, i) => /\b(?:approvalMode|sellerApprovalMode)\s*(?:={2,3}\s*|,\s*)['"](?:policy|manual)['"]/.test(line)
      && (/\bassert\./.test(line) || /\b(?:FinalityCommitmentRecord|PartyVet|CompositeVerificationRecord)\b/.test(line)) ? [i + 1] : []);
    if (approvals.length) hits.push('pre-payment policy approval assertion at ' + approvals.join(', '));
  }
  if (!hits.length) continue;
  if (!replaced.has(path) && !hostOnly.has(path) && !policyReview.has(path) && !excluded.has(path)) throw new Error('Unclassified copied-test reference: ' + path);
  const disposition = replaced.has(path) ? 'Superseded expectations: see the semantic table above; rehost against D5.'
    : policyReview.get(path) ?? (excluded.has(path) ? 'Excluded plugin-only operations/hosting test; no kit behavior is claimed.'
      : 'D12 host/comparison fixture: recheck buyer harness state and policy assertions when rehosting.');
  rows.push(`| \`${path}\` | ${hits.join('; ')} | ${disposition} |`);
}
const begin = '<!-- BEGIN COPIED-TEST SCAN: scripts/superseded-tests.mjs -->', end = '<!-- END COPIED-TEST SCAN -->';
const block = [begin, 'Removed exports: ' + [...removed].sort().map(n => '`' + n + '`').join(', ') + '.', '',
  '| Copied file | Mechanically located signals | Reviewed disposition |', '| --- | --- | --- |', ...rows, end].join('\n');
if (process.argv.includes('--print')) console.log(block);
else {
  for (const name of ['DELTA-MAP.md', 'REVIEW-NOTES.md']) {
    const path = join(pkg, name), text = readFileSync(path, 'utf8');
    const manual = text.split(begin)[0];
    for (const file of replaced) if (!manual.includes('`' + file + ':') && !manual.includes('`' + file + '`')) throw new Error(name + ': superseded file missing: ' + file);
    for (const file of policyReview.keys()) if (!manual.includes('`' + file + ':') && !manual.includes('`' + file + '`')) throw new Error(name + ': policy review file missing: ' + file);
    const start = text.indexOf(begin), stop = text.indexOf(end, start);
    const next = start < 0 ? text.trimEnd() + '\n\n' + block + '\n' : text.slice(0, start) + block + text.slice(stop + end.length);
    if (process.argv.includes('--check')) { if (next !== text) throw new Error(name + ': copied-test scan is stale'); }
    else writeFileSync(path, next);
  }
  console.log(`copied-test inventory: ${rows.length} candidate files classified; ${replaced.size} superseded files/fixtures; ok`);
}
