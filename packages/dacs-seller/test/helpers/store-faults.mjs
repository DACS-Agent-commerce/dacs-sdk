// Makes numbered calls of a fixture's party Vet store throw a store error that
// changed nothing, as the real store does when it is busy or full.
export const storeError=(code='journal-busy')=>Object.assign(new Error(`TEST ${code}: nothing was changed`),{code});

// Fails the store's `at`-th read or update (counted from 1 across one fixture)
// once; with `persistent`, every later one too until the returned `heal()`.
// Returns the call counts and `heal`.
export function failStoreCall(f,{kind,at,code='journal-busy',persistent=false}){
 const store=f.config.store,faults={read:0,update:0,broken:persistent,heal(){faults.broken=false;}};
 const check=name=>{const count=++faults[name];if(name===kind&&(count===at||(faults.broken&&count>at)))throw storeError(code);};
 f.config.store={...store,
  read:key=>{check('read');return store.read(key);},
  update:(key,change)=>{check('update');return store.update(key,change);},
 };
 return faults;
}
