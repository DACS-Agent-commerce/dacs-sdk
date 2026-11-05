import { createRequire } from 'node:module';
import { types } from 'node:util';
import { retireSqliteHandle, isSqliteHandleRetired } from './sqlite-write-lease.mjs';

const require = createRequire(import.meta.url);
const callbacks = [];
const FUNCTION_OPCODE = /^(Function|PureFunc|AggStep|AggFinal|AggValue|AggInverse)\d*$/;
// Virtual tables (including pragma_*() and ALTER TABLE checks) compile and run
// SQL while the statement runs, so EXPLAIN cannot show the functions they call.
const VIRTUAL_TABLE_OPCODE = /^V(Begin|Check|Column|Create|Destroy|Filter|InitIn|Next|Open|Rename|Update)$/;
const REFUSED_PROGRAM = 'SQL callbacks, virtual tables or unrecognized function opcodes are unsupported by the statement guard';
const REFUSED_BINDINGS = 'named bindings with accessors or proxies are unsupported by the statement guard';
const owners = new WeakMap(), iterators = new WeakMap(), registrations = new WeakMap();
let installed = false, checking = false, nativeExec, nativePrepare, nativeAll, builtinNames, bundledExtensionNames;
const POLICY_ROW = { query_only: 'number' };
const FUNCTION_ROW = { name: 'string', builtin: 'number', type: 'string', enc: 'string', narg: 'number', flags: 'number' };
const PROGRAM_ROW = { addr: 'number', opcode: 'string', p1: 'number', p2: 'number', p3: 'number', p4: 'nullable string', p5: 'number', comment: 'nullable string' };
// Normalize only our statements; caller statements keep the connection defaults.
function metadataRows(db, sql, shape) {
  const statement = shape === PROGRAM_ROW ? guardedPrepare(db, sql) : nativePrepare.call(db, sql);
  statement.setReturnArrays?.(false);
  statement.setReadBigInts?.(false);
  const rows = nativeAll.call(statement);
  if (!Array.isArray(rows) || rows.some(row => !row || ![null, Object.prototype].includes(Object.getPrototypeOf(row))
    || Reflect.ownKeys(row).length !== Object.keys(shape).length
    || Object.entries(shape).some(([key, type]) => {
      if (!Object.hasOwn(row, key)) return true;
      const value = row[key];
      return type === 'number' ? !Number.isSafeInteger(value)
        : type === 'nullable string' ? value !== null && typeof value !== 'string' : typeof value !== type;
    }))) throw new TypeError('unrecognized metadata rows in the statement guard');
  return rows;
}
function queryOnly(db) {
  const rows = metadataRows(db, 'PRAGMA query_only', POLICY_ROW);
  if (rows.length !== 1 || ![0, 1].includes(rows[0].query_only)) throw new TypeError('unrecognized read-only policy in the statement guard');
  return rows[0].query_only;
}
function synchronousResult(db, result) {
  if (result !== undefined) {
    retireSqliteHandle(db);
    // Observe native rejection only after retirement; never inspect result.then.
    if (types.isPromise(result)) Promise.prototype.then.call(result, undefined, () => {});
    throw new TypeError('statement guard callbacks must return undefined as their synchronous result');
  }
}
function guardedPrepare(db, ...args) {
  try { return Reflect.apply(nativePrepare, db, args); }
  finally {
    // SQLite changes query_only during preparation, even for EXPLAIN. Close
    // the fence before returning a statement or inspecting its program.
    if (callbacks.some(frame => frame.db === db) && !isSqliteHandleRetired(db)
      && queryOnly(db) !== 1) {
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
function applicationFunctions(db) {
  const names = new Set(registrations.get(db));
  for (const row of metadataRows(db, 'PRAGMA function_list', FUNCTION_ROW)) {
    if (row.builtin !== 1) names.add(row.name.toLowerCase());
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
    const prefix = sql.replace(/^(?:\s|\/\*[\s\S]*?\*\/|--[^\n]*(?:\n|$))*/, '');
    if (/^EXPLAIN\b/i.test(prefix)) throw new TypeError('EXPLAIN is unsupported by the statement guard');
    const program = metadataRows(db, `EXPLAIN ${sql}`, PROGRAM_ROW);
    if (!program.length) throw new TypeError(REFUSED_PROGRAM);
    if (program.some(row => {
      if (VIRTUAL_TABLE_OPCODE.test(row.opcode)) return true;
      if (!FUNCTION_OPCODE.test(row.opcode)) return false;
      const name = /^([\s\S]*)\(-?\d+\)$/.exec(String(row.p4));
      return !name || !builtinNames.has(name[1].toLowerCase()) || functions.has(name[1].toLowerCase()) || bundledExtensionNames.has(name[1].toLowerCase());
    })) {
      throw new TypeError(REFUSED_PROGRAM);
    }
  }
  const frame = callbacks.find(frame => frame.db === db);
  // Only a guarded connection's frame may open its writable fence.
  if (!frame) return fn();
  try {
    nativeExec.call(db, 'PRAGMA query_only=OFF');
    return fn();
  } finally {
    if (!isSqliteHandleRetired(db)) {
      try { nativeExec.call(db, 'PRAGMA query_only=ON'); }
      catch { retireSqliteHandle(db); }
    }
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
  const { DatabaseSync } = require('node:sqlite');
  if (!(db instanceof DatabaseSync)) throw new TypeError('DatabaseSync required');
  if (installed) return;
  const database = DatabaseSync.prototype;
  const prepare = database.prepare, exec = database.exec;
  const statement = Object.getPrototypeOf(prepare.call(db, 'SELECT 1'));
  const iterator = Object.getPrototypeOf(statement.iterate.call(prepare.call(db, 'SELECT 1')));
  const advance = iterator.next;
  nativeExec = exec; nativePrepare = prepare; nativeAll = statement.all;
  const fresh = new DatabaseSync(':memory:');
  try {
    const functions = metadataRows(fresh, 'PRAGMA function_list', FUNCTION_ROW);
    builtinNames = new Set(functions.filter(row => row.builtin === 1).map(row => row.name.toLowerCase()));
    bundledExtensionNames = new Set(functions.filter(row => row.builtin !== 1).map(row => row.name.toLowerCase()));
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

/** Check liveness at patched prepare/exec, statement run/get/all/iterate and
 * iterator next calls. Predicate and body must be synchronous functions returning
 * undefined; another result retires the handle. Thrown errors retain identity.
 * Entry requires query_only=OFF. Nested guards inherit the parent's ON fence.
 * Predicate SQL bypasses recursive checks. Accessor/proxy bindings, SQL callbacks,
 * virtual tables, EXPLAIN and statements prepared before installation are refused.
 * On Node 22.13.0/23.4.0 only iterators created after installation have own next
 * wrapped. Native methods stay unrestricted outside guards. Captured native
 * writers fail between grants; deliberately clearing the native flag requires
 * a native authorizer, which Node 22 lacks.
 */
export function withSqliteStatementGuard(db, predicate, fn) {
  if ([predicate, fn].some(callback => typeof callback !== 'function' || types.isAsyncFunction(callback) || types.isGeneratorFunction(callback))) {
    throw new TypeError('the statement guard predicate and body must be synchronous functions');
  }
  if (isSqliteHandleRetired(db)) throw new TypeError('the statement guard connection is retired');
  install(db);
  const parent = callbacks.find(frame => frame.db === db);
  if (!parent && queryOnly(db) !== 0) throw new TypeError('the statement guard requires a writable read-only policy');
  nativeExec.call(db, 'PRAGMA query_only=ON');
  callbacks.push({ db, predicate });
  try { check(); return synchronousResult(db, fn()); }
  finally {
    callbacks.pop();
    if (!isSqliteHandleRetired(db)) {
      try { nativeExec.call(db, parent ? 'PRAGMA query_only=ON' : 'PRAGMA query_only=OFF'); }
      catch { retireSqliteHandle(db); }
    }
  }
}
