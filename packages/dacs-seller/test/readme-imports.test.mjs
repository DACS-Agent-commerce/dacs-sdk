import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageUrl = new URL('../', import.meta.url);
const readme = readFileSync(new URL('README.md', packageUrl), 'utf8');

const namesIn = (list) => [...list.matchAll(/[A-Za-z_$][\w$]*/g)].map((match) => match[0]);

test('every import in the README names an export of the module it imports from', async () => {
  const imports = [...readme.matchAll(/^import \{([^}]*)\} from '([^']+)';$/gm)];
  assert.ok(imports.length > 0, 'the README shows at least one import');
  for (const [, list, specifier] of imports) {
    assert.match(specifier, /^\.\/src\//, `${specifier} must be a path inside the package`);
    const exported = await import(new URL(specifier, packageUrl));
    for (const name of namesIn(list)) assert.ok(name in exported, `${specifier} does not export ${name}`);
  }
});

test('the README lists exactly the exports of the package root', async () => {
  const sentence = readme.match(/The root `src\/index\.mjs` exports ([^.]*)\./)?.[1];
  assert.ok(sentence, 'the README states what the root exports');
  const listed = [...sentence.matchAll(/`([^`]+)`/g)].map((match) => match[1]).sort();
  const exported = Object.keys(await import(new URL('src/index.mjs', packageUrl))).sort();
  assert.deepEqual(listed, exported);
});
