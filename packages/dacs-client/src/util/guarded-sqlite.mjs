import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const callbacks = [];
const FUNCTION_OPCODE = /^(Function|PureFunc|AggStep|AggFinal|AggValue|AggInverse)\d*$/;
// Virtual tables (including pragma_*() and ALTER TABLE checks) compile and run
// SQL while the statement runs, so EXPLAIN cannot show the functions they call.
const VIRTUAL_TABLE_OPCODE = /^V(Begin|Check|Column|Create|Destroy|Filter|InitIn|Next|Open|Rename|Update)$/;
const REFUSED_PROGRAM = 'SQL callbacks, virtual tables or unrecognized function opcodes are unsupported by the statement guard';
const owners = new WeakMap(), iterators = new WeakMap();
let installed = false, checking = false, nativeExec, nativePrepare, nativeGet, nativeAll;
function check() {
  if (checking) return;
  checking = true;
  try { for (const { predicate } of callbacks) predicate(); }
  finally { checking = false; }
}
function applicationFunctions(db) {
  return new Set(nativeAll.call(nativePrepare.call(db, 'PRAGMA function_list'))
    .filter(row => !row.builtin).map(row => row.name.toLowerCase()));
}
function execute(fn, db, sql) {
  check();
  if (checking || callbacks.length === 0) return fn();
  // A statement prepared before installation has no known owner, so its
  // program cannot be inspected: refuse it while any guarded connection has
  // application functions it might call.
  if (!db && callbacks.some(frame => applicationFunctions(frame.db).size > 0)) {
    throw new TypeError(REFUSED_PROGRAM);
  }
  // EXPLAIN includes trigger programs. Application functions (including
  // overrides of built-ins) cannot run while native writers are enabled.
  if (db && sql) {
    const functions = applicationFunctions(db);
    const program = nativeAll.call(nativePrepare.call(db, `EXPLAIN ${sql}`));
    if (program.some(row => {
      if (functions.size > 0 && VIRTUAL_TABLE_OPCODE.test(row.opcode)) return true;
      if (!FUNCTION_OPCODE.test(row.opcode)) return false;
      const name = /^([\s\S]*)\(-?\d+\)$/.exec(String(row.p4));
      return !name || functions.has(name[1].toLowerCase());
    })) {
      throw new TypeError(REFUSED_PROGRAM);
    }
  }
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
  nativeExec = exec; nativePrepare = prepare; nativeGet = statement.get; nativeAll = statement.all;
  // Patch the native statement prototype too: the host may already have
  // prepared a statement before this capability was installed.
  for (const method of ['run', 'get', 'all', 'iterate']) {
    const original = statement[method];
    statement[method] = function (...args) {
      const owner = owners.get(this);
      const result = execute(() => Reflect.apply(original, this, args), owner, this.sourceSQL);
      if (method === 'iterate') iterators.set(result, { db: owner, sql: this.sourceSQL });
      return result;
    };
  }
  iterator.next = function (...args) {
    const owner = iterators.get(this);
    return execute(() => Reflect.apply(advance, this, args), owner?.db, owner?.sql);
  };
  database.prepare = function (...args) {
    check(); const result = Reflect.apply(prepare, this, args); owners.set(result, this); return result;
  };
  for (const method of ['function', 'aggregate']) {
    if (typeof database[method] !== 'function') continue;
    const original = database[method];
    database[method] = function (...args) {
      if (callbacks.length) throw new TypeError('SQL callbacks cannot be registered during a guard');
      return Reflect.apply(original, this, args);
    };
  }
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
      execute(() => exec.call(this, sourceSQL), this, sourceSQL);
      remaining = remaining.slice(sourceSQL.length);
    }
  };
  installed = true;
}

/** Check transaction liveness before every native SQLite execution in fn.
 * The synchronous callback's result/error is preserved; guard errors stop SQL.
 * Native methods remain unrestricted outside guarded callbacks. Predicates
 * may inspect SQLite themselves; those probes bypass recursive checking.
 * SQL callback execution/registration is unsupported during guards, and so are
 * virtual tables (pragma_*() functions) on a connection with application
 * functions, because their SQL is compiled while the statement runs. Statements
 * prepared before installation can only read while a guard is active, and are
 * refused when the guarded connection has application functions.
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
