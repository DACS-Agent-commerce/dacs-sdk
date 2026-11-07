// The flip protocol's rules for harness-index.json (K12 section 1), as a check over an index value so the meta-test can also run it on synthetic indexes.
const PR_ID = /^P\d+[a-z]?\d?[a-z]?$/;
export const CASE_IDS = ['K12-H1', 'K12-H2', 'K12-H3', 'K12-H4-wire', 'K12-H4-host', 'K12-H5', 'K12-H6a', 'K12-H6b', 'K12-H7'];
const ENTRY_MEMBERS = ['id', 'today', 'target', 'owner', 'flippedBy'];
const CURRENT_MEMBERS = ['step', 'code', 'layer', 'counters', 'updatedBy'];
const H7 = 'K12-H7';

const extraMembers = (value, allowed) => Object.keys(value).filter((key) => !allowed.includes(key));
const isCount = (value) => Number.isInteger(value) && value >= 0;

function currentProblems(entry) {
  if (entry.id !== H7) return entry.current === undefined ? [] : [`${entry.id} has a current observation; only ${H7} does`];
  const { current } = entry;
  if (current === undefined) return [`${H7} has no current observation`];
  const problems = extraMembers(current, CURRENT_MEMBERS).map((key) => `${H7} current has unknown member ${key}`);
  if (!current.step || !current.layer) problems.push(`${H7} current names its step and layer`);
  if (current.code !== null && typeof current.code !== 'string') problems.push(`${H7} current code is a string or null`);
  if (!PR_ID.test(current.updatedBy ?? '')) problems.push(`${H7} current names the PR that last updated it`);
  const counters = Object.entries(current.counters ?? {});
  if (counters.length === 0 || !counters.every(([, count]) => isCount(count))) problems.push(`${H7} current counters are non-negative integers`);
  return problems;
}

function entryProblems(entry) {
  const problems = extraMembers(entry, [...ENTRY_MEMBERS, 'current']).map((key) => `${entry.id} has unknown member ${key}`);
  if (!entry.today || !entry.target) problems.push(`${entry.id} states today's and the target behaviour`);
  if (!PR_ID.test(entry.owner ?? '')) problems.push(`${entry.id} names its owning PR`);
  if (entry.flippedBy !== null && entry.flippedBy !== entry.owner) problems.push(`${entry.id} is unflipped or flipped by its owner`);
  return [...problems, ...currentProblems(entry)];
}

/** Every way `index` breaks the protocol: unknown, repeated or missing case ids, and each entry's own problems. Empty when it holds. */
export function indexProblems(index, expectedIds = CASE_IDS) {
  const ids = index.map((entry) => entry.id);
  const problems = [];
  if (new Set(ids).size !== ids.length) problems.push('a case id repeats');
  if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) problems.push(`the index holds ${JSON.stringify(ids)}, not exactly ${JSON.stringify(expectedIds)}`);
  return [...problems, ...index.flatMap(entryProblems)];
}
