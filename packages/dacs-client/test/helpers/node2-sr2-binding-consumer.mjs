// Offline-only SR-2 binding consumer helper. All transport traffic is served
// by injected .invalid stubs from the exact-current Node2 coverage fixture.
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal } from '../../src/dacs/demos-sr2-adapter.mjs';
import { ENDPOINT, NOW, WRITER } from './review-node2-current-coverage-fixture.mjs';

export const LOGICAL='dacs4:agreement:node2-sr2-binding-consumer';
export const SEARCH={searchStoragePrograms:{result:200,response:[]}};

export function createReadOnlySr2Adapter(sourceCapability){
  return createDemosSr2Adapter({rpcUrl:ENDPOINT,sourceCapability,
    journal:{...createInMemoryDemosSr2Journal(),put:async()=>{throw new Error('TEST SR-2 binding consumer refuses writes');}},now:()=>NOW});
}

export const readAbsent=(sourceCapability)=>createReadOnlySr2Adapter(sourceCapability).read(LOGICAL,{expectedWriter:WRITER});
