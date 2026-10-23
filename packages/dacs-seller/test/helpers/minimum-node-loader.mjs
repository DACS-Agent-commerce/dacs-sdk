// Simulate the minimum supported Node without the Node 22-only SQLite API.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:sqlite') throw new Error('TEST minimum Node has no node:sqlite');
  return nextResolve(specifier, context);
}
