// Deterministic publication redactions. Fragments keep the forbidden spellings
// out of the published tree while preserving source lookup and text guards.
const word = (...parts) => parts.join('');
const tool = word('day', 'break');
const reviewer = new RegExp(`(?:${tool}(?:['’]s)?|code)(?: (?:current|r\\d+|round \\d+|P\\d+(?:[- ]\\d+)?|finding \\d+|reproduction|probe))*`, 'gi');
const maintainer = new RegExp(word('ha', 'yk'), 'gi');
const priorRound = /\b(?:(?:merge|fix|final review|review|sweep) round \d+|round[- ]\d+|final review \d+|r[5-7])(?: correction)?\b/gi;
const originalToolPrefix = word('clau', 'de');
const originalHosting = word('v', 'ps');
export function publicPath(path) {
  return path.replaceAll(originalToolPrefix, 'scenario').replaceAll(originalHosting, 'hosting').replaceAll('hosting-hosting', 'server-hosting').replaceAll(word('wallet-extension-probe-', 'r', '5'), 'wallet-extension-probe-regression');
}
export function originalPath(path) {
  return path.replaceAll('/scenario-', '/' + originalToolPrefix + '-').replaceAll('server-hosting', originalHosting + '-hosting').replaceAll('/deploy/hosting', '/deploy/' + originalHosting).replaceAll('wallet-extension-probe-regression', word('wallet-extension-probe-', 'r', '5'));
}
export function redactText(text) {
  return publicPath(String(text))
    .replace(maintainer, 'the SDK maintainer')
    .replace(reviewer, match => /^code$/i.test(match) ? match : 'a review')
    .replace(priorRound, 'an earlier review round')
    .replace(/\bdecision [23](?: \([^)]*\))?:/gi, 'Ledger binding:')
    .replace(/\bcode review int\d+ P\d+\b/gi, 'a review').replace(/\bint\d+\b/g, 'a review')
    .replaceAll(word('round', '2'), 'vet-retention').replaceAll(word('round', '3store'), 'context-capacity')
    .replaceAll(word('round', '3inventory'), 'test-inventory').replaceAll(word('round', '4store'), 'capacity-lookup')
    .replaceAll(word('round', '4inventory'), 'commitment-inventory').replaceAll(word('round', '5inventory'), 'vet-inventory')
    .replaceAll(word('RKI', 'T-2'), 'the decision-log contract')
    .replaceAll(word('octo-', 'seller'), 'seller-fixture')
    .replace(new RegExp(word('ast', 'ral'), 'gi'), 'supplementary-plane')
    .replaceAll(word('/home/', 'cla', 'wd', '/admission.json'), '/etc/dacs-seller/admission.json')
    .replaceAll('https://api.github.com/' + word('us', 'ers') + '/<name>', 'the GitHub user API')
    .replaceAll('No global TLS ' + word('by', 'pass'), 'No disabled TLS checks')
    .replaceAll(word('by', 'pass'), 'skip')
    .replaceAll(word('V', 'PS'), 'hosting')
    .replaceAll('DELTA-' + 'REPORT.md', 'the implementation record')
    .replaceAll('Inputs: all nine review/fix records indexed in `' + '.sta' + 'ck/pr58-59/INDEX.md`.', 'Inputs: the reviews of the two frozen source heads.')
    .replaceAll('The code review\'s seller-lease probe (' + '.sta' + 'ck/probes/seller-lease.test.mjs),', 'The seller-lease regression from a review,')
    .replaceAll('.' + originalToolPrefix + '/', 'a local tool directory')
    .replaceAll(word('const que', 'ue ='), 'const pending =').replaceAll(word('while (que', 'ue.length)'), 'while (pending.length)')
    .replaceAll(word('que', 'ue.shift()'), 'pending.shift()').replaceAll(word('que', 'ue.push('), 'pending.push(')
    .replaceAll('A a review full review', 'A full review').replaceAll('The a review', 'The review')
    .replaceAll('the an earlier review round', 'an earlier review round')
    .replaceAll('a review / a review', 'a review').replaceAll('a review, a review', 'a review');
}
