/** Resolve a provider within fixed read limits; throws its error or resolver-timeout.
 * The provider receives a cancellation signal, aborted on every exit. */
export async function resolveWithDeadline(provider, limits) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('resolver-timeout'));
      controller.abort();
    }, limits.timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error('resolver-timeout');
        return provider({ ...limits, signal: controller.signal });
      }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
