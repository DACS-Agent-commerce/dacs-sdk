import { loadCustody } from './operator-custody-fixture.mjs';

const [directory] = process.argv.slice(2);
const custody = await loadCustody();
custody.state.afterMkdir = async (path) => {
  if (path !== directory) return;
  process.send({ stage: 'after-mkdir' });
  await new Promise(resolve => process.once('message', resolve));
};
try {
  await custody.ensureOperatorSecret({ directory });
  process.send({ stage: 'unexpected-success' });
} catch (error) {
  process.send({ stage: 'error', message: error.message });
} finally { custody.release(); }
