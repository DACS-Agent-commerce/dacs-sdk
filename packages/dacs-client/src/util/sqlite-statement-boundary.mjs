import { createRequire } from 'node:module';
import { types } from 'node:util';
import { retireSqliteHandle, isSqliteHandleRetired } from './sqlite-write-lease.mjs';

const require = createRequire(import.meta.url);
const callbacks = [];
const DEFERRED_BODY = /^\[object (?:Async|Generator|AsyncGenerator)Function\]$/;
const FUNCTION_OPCODE = /^(Function|PureFunc|AggStep|AggFinal|AggValue|AggInverse)\d*$/;
// Virtual tables (including pragma_*() and ALTER TABLE checks) compile and run
// SQL while the statement runs, so EXPLAIN cannot show the functions they call.
const VIRTUAL_TABLE_OPCODE = /^V(Begin|Check|Column|Create|Destroy|Filter|InitIn|Next|Open|Rename|Update)$/;
const REFUSED_PROGRAM = 'SQL callbacks, virtual tables or unrecognized function opcodes are unsupported by the statement guard';
const REFUSED_BINDINGS = 'named bindings with accessors or proxies are unsupported by the statement guard';
const owners = new WeakMap(), iterators = new WeakMap(), registrations = new WeakMap();
let installed = false, checking = false, nativeExec, nativePrepare, nativeGet, nativeAll, bundledExtensions, bundledExtensionNames;
function synchronousResult(db, result) {
  let deferred;
  try { deferred = types.isPromise(result) || typeof result?.then === 'function'; }
  catch (error) { retireSqliteHandle(db); throw error; }
  if (deferred) {
    retireSqliteHandle(db);
    // Observe rejection without executing a user-provided thenable body.
    if (types.isPromise(result)) Promise.prototype.then.call(result, undefined, () => {});
    throw new TypeError('statement guard callbacks must return a synchronous result');
  }
  return result;
}
function guardedPrepare(db, ...args) {
  try { return Reflect.apply(nativePrepare, db, args); }
  finally {
    // SQLite changes query_only during preparation, even for EXPLAIN. Close
    // the fence before returning a statement or inspecting its program.
    if (callbacks.some(frame => frame.db === db) && !isSqliteHandleRetired(db)
      && Number(nativeGet.call(nativePrepare.call(db, 'PRAGMA query_only')).query_only) === 0) {
      try { nativeExec.call(db, 'PRAGMA query_only=ON'); }
      catch { retireSqliteHandle(db); }
      throw new TypeError('guarded SQL cannot clear the read-only policy');
    }
  }
}
function check() {
  if (checking) return;
  checking = true;
  try { for (const { db, predicate } of callbacks) synchronousResult(db, predicate()); }
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
// Every fresh connection lists the bundled FTS, RTREE and GEOPOLY functions as
// non-builtin. An application function with the same name and arity has the
// same name, arity, type, encoding and flags, so PRAGMA function_list cannot
// tell the two apart: their names are refused wherever they are called, and
// functions registered through the patched registration methods are recorded.
const functionIdentity = row => [row.name.toLowerCase(), row.narg, row.enc, row.type, row.flags].join('/');
function applicationFunctions(db) {
  const names = new Set(registrations.get(db));
  for (const row of nativeAll.call(nativePrepare.call(db, 'PRAGMA function_list'))) {
    if (!row.builtin && !bundledExtensions.has(functionIdentity(row))) names.add(row.name.toLowerCase());
  }
  return names;
}
function rememberRegistration(db, name) {
  const names = registrations.get(db) ?? new Set();
  names.add(name.toLowerCase());
  registrations.set(db, names);
}
function execute(fn, db, sql) {
  check();
  if (checking || callbacks.length === 0) return fn();
  // Earlier statements have no known owner or inspectable program. Even an
  // apparently bundled function may be an indistinguishable application override.
  if (!db) throw new TypeError(REFUSED_PROGRAM);
  // EXPLAIN includes trigger programs. Application functions (including
  // overrides of built-ins) cannot run while native writers are enabled.
  if (db && sql) {
    const functions = applicationFunctions(db);
    const program = nativeAll.call(guardedPrepare(db, `EXPLAIN ${sql}`));
    if (program.some(row => {
      if (VIRTUAL_TABLE_OPCODE.test(row.opcode)) return true;
      if (!FUNCTION_OPCODE.test(row.opcode)) return false;
      const name = /^([\s\S]*)\(-?\d+\)$/.exec(String(row.p4));
      return !name || functions.has(name[1].toLowerCase()) || bundledExtensionNames.has(name[1].toLowerCase());
    })) {
      throw new TypeError(REFUSED_PROGRAM);
    }
  }
  const frame = callbacks.find(frame => frame.db === db);
  // Only a guarded connection's frame may open its writable fence.
  if (!frame?.writable) return fn();
  try {
    nativeExec.call(db, 'PRAGMA query_only=OFF');
    return fn();
  } finally {
    try { nativeExec.call(db, 'PRAGMA query_only=ON'); }
    catch { try { db.close(); } catch { /* A failed fence retires the handle. */ } }
  }
}
// Node 22.13.0 and 23.4.0 give each iterator its own `next`, which shadows the
// shared prototype method patched in install(). Wrap that own method, or the
// step would run without the liveness check and without the writable fence.
function guardIteratorSteps(iterator, db, sql) {
  iterators.set(iterator, { db, sql });
  const ownAdvance = Object.getOwnPropertyDescriptor(iterator, 'next')?.value;
  if (typeof ownAdvance !== 'function') return;
  Object.defineProperty(iterator, 'next', {
    configurable: true,
    writable: true,
    value: (...args) => execute(() => Reflect.apply(ownAdvance, iterator, args), db, sql),
  });
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
  const fresh = new DatabaseSync(':memory:');
  try {
    const extensions = nativeAll.call(nativePrepare.call(fresh, 'PRAGMA function_list')).filter(row => !row.builtin);
    bundledExtensions = new Set(extensions.map(functionIdentity));
    bundledExtensionNames = new Set(extensions.map(row => row.name.toLowerCase()));
  } finally { fresh.close(); }
  // Patch the native statement prototype too: the host may already have
  // prepared a statement before this capability was installed.
  for (const method of ['run', 'get', 'all', 'iterate']) {
    const original = statement[method];
    statement[method] = function (...args) {
      const owner = owners.get(this);
      if (callbacks.length > 0 && !checking) rejectCodeRunningBindings(args);
      const result = execute(() => Reflect.apply(original, this, args), owner, this.sourceSQL);
      if (method === 'iterate') guardIteratorSteps(result, owner, this.sourceSQL);
      return result;
    };
  }
  // Only newer Node versions have a shared prototype `next` to patch.
  if (advance) {
    iterator.next = function (...args) {
      const owner = iterators.get(this);
      return execute(() => Reflect.apply(advance, this, args), owner?.db, owner?.sql);
    };
  }
  database.prepare = function (...args) {
    check(); const result = guardedPrepare(this, ...args); owners.set(result, this); return result;
  };
  for (const method of ['function', 'aggregate']) {
    if (typeof database[method] !== 'function') continue;
    const original = database[method];
    database[method] = function (...args) {
      if (callbacks.length) throw new TypeError('SQL callbacks cannot be registered during a guard');
      const result = Reflect.apply(original, this, args);
      rememberRegistration(this, args[0]);
      return result;
    };
  }
  database.exec = function (sql) {
    if (callbacks.length === 0 || checking || typeof sql !== 'string') return exec.call(this, sql);
    // SQLite itself finds statement boundaries, including CREATE TRIGGER
    // bodies and quoted semicolons. Never pass a whole batch after one check.
    let remaining = sql;
    while (remaining.length) {
      check();
      const next = guardedPrepare(this, remaining);
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
 * Named bindings (objects or functions) with accessors or proxies are refused
 * during guards, because reading them runs caller code after the last liveness
 * check.
 * SQL callback execution/registration is unsupported during guards, and so are
 * virtual tables (pragma_*() functions), because their SQL is compiled while
 * the statement runs. Statements and iterators prepared before installation
 * are refused while a guard is active because their programs cannot be inspected.
 * Exception: Node 22.13.0 and 23.4.0 give each iterator its own native `next`,
 * which only iterators created after installation can have wrapped.
 * An application function that shares the name and arity of a bundled FTS,
 * RTREE or GEOPOLY function looks identical to it, so calls to those bundled
 * functions are refused by name under a guard, even if registered before this
 * module was first used. A promise result permanently retires the connection
 * before a continuation can use its retained statements.
 * SQL that clears query_only is refused at preparation, including EXPLAIN;
 * an unreadable thenable result also permanently retires the connection.
 * This stops stale code from writing through ordinary or captured native
 * writers. It does not stop code that deliberately holds a native exec and
 * clears query_only; that needs a native authorizer, which Node 22 lacks.
 */
export function withSqliteStatementGuard(db, predicate, fn) {
  if ([predicate, fn].some(callback => typeof callback !== 'function' || DEFERRED_BODY.test(Object.prototype.toString.call(callback)))) {
    throw new TypeError('the statement guard predicate and body must be synchronous functions');
  }
  if (isSqliteHandleRetired(db)) throw new TypeError('the statement guard connection is retired');
  install(db);
  const saved = nativeGet.call(nativePrepare.call(db, 'PRAGMA query_only')).query_only;
  const parent = callbacks.find(frame => frame.db === db);
  // The connection-level flag survives automatic rollback, so native writers
  // captured before installation fail on it. It is not a security boundary:
  // code that holds a native exec can clear the flag itself.
  nativeExec.call(db, 'PRAGMA query_only=ON');
  callbacks.push({ db, predicate, writable: parent ? parent.writable : Number(saved) === 0 });
  try {
    check();
    return synchronousResult(db, fn());
  }
  finally {
    callbacks.pop();
    try { nativeExec.call(db, `PRAGMA query_only=${saved}`); } catch { /* A retired handle stays closed. */ }
  }
}
