// Unshipped module-resolve hook: posts every resolved module URL to the port the registering process passes, so a test can
// read the import closure of one module.
let port;

/** Receives the message port a `register(..., { data: { port } })` call hands over. */
export async function initialize(data) { port = data.port; }

/** Resolves as usual and posts the resolved URL. */
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  port.postMessage(resolved.url);
  return resolved;
}
