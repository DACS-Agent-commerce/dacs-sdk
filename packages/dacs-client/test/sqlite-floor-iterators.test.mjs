// The LegacyDatabase fixture stands in for the engine floors (Node 22.13.0 and
// 23.4.0), whose statement iterators carry their own next and return.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { LegacyDatabase } from './helpers/purchase-tx-fixtures.mjs';

function legacyIterator(t, sql) {
  const db = new LegacyDatabase(':memory:');
  t.after(() => db.close());
  return db.prepare(sql).iterate();
}

test('a LegacyDatabase iterator has its own next', t => {
  const iterator = legacyIterator(t, 'SELECT 1 AS one');
  assert.ok(Object.hasOwn(iterator, 'next'));
  iterator.return();
});

test('a LegacyDatabase iterator has its own return', t => {
  const iterator = legacyIterator(t, 'SELECT 1 AS one');
  assert.ok(Object.hasOwn(iterator, 'return'));
  iterator.return();
});

test('a LegacyDatabase iterator still yields every row and then finishes', t => {
  const iterator = legacyIterator(t, 'SELECT 1 AS one UNION ALL SELECT 2');
  assert.deepEqual([...iterator].map(row => row.one), [1, 2]);
});

// Each wrapper must ship together with every test/helper it imports, including
// worker modules named with new URL(..., import.meta.url).
for (const name of readdirSync(new URL('.', import.meta.url)).filter(name => name.endsWith('.floor.test.mjs'))) {
  test(`floor wrapper ${name} has all relative module dependencies`, () => {
    const seen = new Set();
    function visit(file) {
      if (seen.has(file.href)) return;
      seen.add(file.href);
      assert.ok(existsSync(file), `missing floor dependency ${file.pathname}`);
      if (!/\.m?js$/.test(file.pathname)) return;
      const source = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      function edge(node) {
        let specifier;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
        else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0];
        else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') specifier = node.arguments?.[0];
        if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
          const dependency = new URL(specifier.text, file);
          if (/\.(?:mjs|js|json)$/.test(dependency.pathname)) visit(dependency);
        }
        ts.forEachChild(node, edge);
      }
      edge(source);
    }
    visit(new URL(name, import.meta.url));
  });
}
