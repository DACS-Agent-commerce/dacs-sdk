// Records every server that starts listening in this test process. A test
// whose close left a listener open would otherwise keep the file alive until
// the runner kills it; cleanup instead cuts it and fails at once.
import net from 'node:net';
const listening = new Set();
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  listening.add(this);
  this.once('close', () => listening.delete(this));
  return listen.apply(this, args);
};
export const openListeners = () => [...listening].filter(server => server.listening);
export async function failOnLeftoverListeners() {
  const left = openListeners();
  for (const server of left) { server.closeAllConnections?.(); await new Promise(resolve => server.close(() => resolve())); }
  listening.clear();
  if (left.length) throw new Error(`${left.length} listener(s) were still open after cleanup`);
}
