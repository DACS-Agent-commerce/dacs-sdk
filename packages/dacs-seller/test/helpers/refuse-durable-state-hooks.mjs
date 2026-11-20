// Module hooks for a child process: loading the durable-state module is an error.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('seller-durable-state.mjs')) throw new Error('seller-durable-state.mjs was loaded');
  return nextResolve(specifier, context);
}
