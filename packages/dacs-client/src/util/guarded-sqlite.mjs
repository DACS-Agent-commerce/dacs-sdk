import { createRequire } from 'node:module';
import { types } from 'node:util';

const require = createRequire(import.meta.url);
const callbacks = [];
const REFUSED_BINDINGS = 'named bindings with accessors or proxies are unsupported by the statement guard';
const owners = new WeakMap(), iterators = new WeakMap();
let installed = false, checking = false, nativeExec, nativePrepare, nativeGet;
function check() {
  if (checking) return;
  checking = true;
  try { for (const { predicate } of callbacks) predicate(); }
  finally { checking = false; }
}
// Reading a binding object can run caller code (accessors, proxy traps), and
// the native method reads it after the writable fence is open, past the last
// liveness check. Only plain data properties are accepted while a guard is on.
function rejectCodeRunningBindings(args) {
  for (const arg of args) {
    // Node also reads a function argument as a named-bindings object.
    if ((typeof arg !== 'object' && typeof arg !== 'function') || arg === null || ArrayBuffer.isView(arg)) continue;
    if (types.isProxy(arg) || Reflect.ownKeys(arg).some(key => {
      const { get, set } = Reflect.getOwnPropertyDescriptor(arg, key);
      return get || set;
    })) throw new TypeError(REFUSED_BINDINGS);
  }
}
function execute(fn, db) {
  check();
  if (checking || callbacks.length === 0) return fn();
  const frame = callbacks.find(frame => frame.db === db);
  // Statements predating installation have no known owner. They retain the
  // read-only fence; never open a different connection on their behalf.
  if (!frame?.writable) return fn();
  try {
    nativeExec.call(db, 'PRAGMA query_only=OFF');
    return fn();
  } finally {
    try { nativeExec.call(db, 'PRAGMA query_only=ON'); }
    catch { try { db.close(); } catch { /* A failed fence retires the handle. */ } }
  }
}
function install(db) {
  if (installed) return;
  const { DatabaseSync } = require('node:sqlite');
  if (!(db instanceof DatabaseSync)) throw new TypeError('DatabaseSync required');
  const database = DatabaseSync.prototype;
  const prepare = database.prepare, exec = database.exec;
  const statement = Object.getPrototypeOf(prepare.call(db, 'SELECT 1'));
  const iterator = Object.getPrototypeOf(statement.iterate.call(prepare.call(db, 'SELECT 1')));
  const advance = iterator.next;
  nativeExec = exec; nativePrepare = prepare; nativeGet = statement.get;
  // Patch the native statement prototype too: the host may already have
  // prepared a statement before this capability was installed.
  for (const method of ['run', 'get', 'all', 'iterate']) {
    const original = statement[method];
    statement[method] = function (...args) {
      const owner = owners.get(this);
      if (callbacks.length > 0 && !checking) rejectCodeRunningBindings(args);
      const result = execute(() => Reflect.apply(original, this, args), owner);
      if (method === 'iterate') iterators.set(result, owner);
      return result;
    };
  }
  iterator.next = function (...args) {
    const owner = iterators.get(this);
    return execute(() => Reflect.apply(advance, this, args), owner);
  };
  database.prepare = function (...args) {
    check(); const result = Reflect.apply(prepare, this, args); owners.set(result, this); return result;
  };
  database.exec = function (sql) {
    if (callbacks.length === 0 || checking || typeof sql !== 'string') return exec.call(this, sql);
    // SQLite itself finds statement boundaries, including CREATE TRIGGER
    // bodies and quoted semicolons. Never pass a whole batch after one check.
    let remaining = sql;
    while (remaining.length) {
      check();
      const next = prepare.call(this, remaining);
      let sourceSQL;
      try { sourceSQL = next.sourceSQL; }
      catch (error) {
        // SQLite returned no statement (comments, BOM, NUL or whitespace).
        if (error.code !== 'ERR_INVALID_STATE') throw error;
        break;
      }
      if (!sourceSQL) break;
      execute(() => exec.call(this, sourceSQL), this);
      remaining = remaining.slice(sourceSQL.length);
    }
  };
  installed = true;
}

/** Check transaction liveness before every native SQLite execution in fn.
 * The synchronous callback's result/error is preserved; guard errors stop SQL.
 * Native methods remain unrestricted outside guarded callbacks. Predicates
 * may inspect SQLite themselves; those probes bypass recursive checking.
 * Named bindings (objects or functions) with accessors or proxies are refused
 * during guards, because reading them runs caller code after the last liveness
 * check.
 * Statements prepared before installation can only read while a guard is
 * active. Application SQL callbacks (db.function, db.aggregate) are neither
 * inspected nor refused here: a callback that runs while the fence is open can
 * write, so this module alone is not safe on a connection that has them.
 * This stops stale code from writing through ordinary or captured native
 * writers. It does not stop code that deliberately holds a native exec and
 * clears query_only; that needs a native authorizer, which Node 22 lacks.
 */
export function withSqliteStatementGuard(db, predicate, fn) {
  install(db);
  const saved = nativeGet.call(nativePrepare.call(db, 'PRAGMA query_only')).query_only;
  const parent = callbacks.find(frame => frame.db === db);
  // The connection-level flag survives automatic rollback, so native writers
  // captured before installation fail on it. It is not a security boundary:
  // code that holds a native exec can clear the flag itself.
  nativeExec.call(db, 'PRAGMA query_only=ON');
  callbacks.push({ db, predicate, writable: parent ? parent.writable : saved === 0 });
  try { check(); return fn(); }
  finally {
    callbacks.pop();
    try { nativeExec.call(db, `PRAGMA query_only=${saved}`); } catch { /* A retired handle stays closed. */ }
  }
}
