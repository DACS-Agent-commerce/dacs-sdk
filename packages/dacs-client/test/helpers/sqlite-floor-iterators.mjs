// Statement iterators with the layout Node 22.13.0 and 23.4.0 give them: each
// iterator carries its own `next` and `return`, and its prototype has no `next`.
// Newer Node versions share those methods through a prototype instead. Import
// this module before the statement guard is first installed, so the guard wraps
// the patched `iterate`.
import { DatabaseSync } from 'node:sqlite';

const probe = new DatabaseSync(':memory:');
const statementPrototype = Object.getPrototypeOf(probe.prepare('SELECT 1'));
const nativeIterate = statementPrototype.iterate;
const { next: nativeNext, return: nativeReturn } = Object.getPrototypeOf(nativeIterate.call(probe.prepare('SELECT 1')));
probe.close();

const floorStatements = new WeakSet();
let everyStatement = false;

function ownMethod(iterator, method) {
  const value = (...args) => Reflect.apply(method, iterator, args);
  return { value, writable: true, configurable: true, enumerable: true };
}

// The engine floors already return this layout themselves.
if (typeof nativeNext === 'function') {
  statementPrototype.iterate = function iterateWithFloorLayout(...args) {
    const native = Reflect.apply(nativeIterate, this, args);
    if (!everyStatement && !floorStatements.has(this)) return native;
    const iterator = Object.create(Iterator.prototype);
    Object.defineProperty(iterator, 'next', ownMethod(native, nativeNext));
    Object.defineProperty(iterator, 'return', ownMethod(native, nativeReturn));
    return iterator;
  };
}

/** Make every iterator of this statement carry its own `next` and `return`, as on the engine floors; returns the statement. */
export function withFloorIterators(statement) {
  floorStatements.add(statement);
  return statement;
}

/** Make the iterator of every statement in this process carry its own `next` and `return`. */
export function useFloorIteratorsEverywhere() {
  everyStatement = true;
}
