import { leaseInternals } from './lease-internals.mjs';
const lease = await leaseInternals();
lease.takeLease(process.argv[2]);
process.send({ namespace: lease.NAMESPACE, process: lease.PROCESS, pid: process.pid });
process.on('message', () => {});
