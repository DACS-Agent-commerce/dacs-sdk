import { join } from 'node:path';
import { loadCustody } from './operator-custody-fixture.mjs';

const [directory, role] = process.argv.slice(2);
const custody = await loadCustody();
custody.state.beforeUnlink = async (path) => {
  if (path !== join(directory, `${role}-wallet.json`)) return;
  process.send({ stage: 'before-unlink' });
  await new Promise((resolve) => process.once('message', resolve));
};
try {
  await custody.bootstrapTestWalletCustody({ directory, publicOrigin: 'http://127.0.0.1:8787' });
  process.send({ stage: 'unexpected-success' });
} catch (error) {
  process.send({ stage: 'error', message: error.message });
} finally { custody.release(); }
