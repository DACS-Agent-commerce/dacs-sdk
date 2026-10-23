import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const callbacks = [];
let installed = false, checking = false;
function check() {
  if (checking) return;
  checking = true;
  try { for (const predicate of callbacks) predicate(); }
  finally { checking = false; }
}
function install(db) {
  if (installed) return;
  const { DatabaseSync } = require('node:sqlite');
  if (!(db instanceof DatabaseSync)) throw new TypeError('DatabaseSync required');
  const database = DatabaseSync.prototype;
  const prepare = database.prepare, exec = database.exec;
  const statement = Object.getPrototypeOf(prepare.call(db, 'SELECT 1'));
  const run = statement.run;
  // Patch the native statement prototype too: the host may already have
  // prepared a statement before this capability was installed.
  for (const method of ['run', 'get', 'all', 'iterate']) {
    const original = statement[method];
    statement[method] = function (...args) {
      check();
      const result = Reflect.apply(original, this, args);
      if (method !== 'iterate' || callbacks.length === 0 || checking) return result;
      return {
        next(...values) { check(); return result.next(...values); },
        return(...values) { return result.return(...values); },
        [Symbol.iterator]() { return this; },
      };
    };
  }
  database.prepare = function (...args) { check(); return Reflect.apply(prepare, this, args); };
  database.exec = function (sql) {
    if (callbacks.length === 0 || checking) return exec.call(this, sql);
    // SQLite itself finds statement boundaries, including CREATE TRIGGER
    // bodies and quoted semicolons. Never pass a whole batch after one check.
    let remaining = sql;
    while (remaining.length) {
      check();
      if (/^(?:\s|;|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*$/.test(remaining)) break;
      const next = prepare.call(this, remaining);
      const consumed = next.sourceSQL.length;
      run.call(next);
      remaining = remaining.slice(consumed);
    }
  };
  installed = true;
}

/** Check transaction liveness before every native SQLite execution in fn.
 * The synchronous callback's result/error is preserved; guard errors stop SQL.
 * Native methods remain unrestricted outside guarded callbacks. Predicates
 * may inspect SQLite themselves; those probes bypass recursive checking.
 */
export function withSqliteStatementGuard(db, predicate, fn) {
  install(db);
  callbacks.push(predicate);
  try { check(); return fn(); }
  finally { callbacks.pop(); }
}
