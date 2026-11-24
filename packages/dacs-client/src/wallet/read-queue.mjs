// The bounded read queue of the Node wallet session's authority capability.

// Runs at most `limit` reads at once. The rest wait in order, and a waiter leaves with the signal's reason when its signal aborts.
export function createReadQueue(limit) {
  let running = 0;
  const waiting = [];
  const release = () => { const next = waiting.shift(); if (next) next(); else running -= 1; };
  return async function runQueued(read, signal) {
    signal.throwIfAborted();
    if (running < limit) running += 1;
    else {
      await new Promise((resolve, reject) => {
        const turn = () => { signal.removeEventListener('abort', leave); resolve(); };
        const leave = () => { waiting.splice(waiting.indexOf(turn), 1); reject(signal.reason); };
        waiting.push(turn);
        signal.addEventListener('abort', leave, { once: true });
      });
    }
    try { return await read(); } finally { release(); }
  };
}
