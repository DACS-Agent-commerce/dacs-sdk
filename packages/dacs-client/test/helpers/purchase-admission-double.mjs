// Test-only stand-in for src/dacs/purchase-admission-state.mjs. A live binding
// with a setter lets a test flip the hold at a barrier. Never under src/ or files.
export let PURCHASE_ADMISSION = 'held';
export const setPurchaseAdmission = (value) => { PURCHASE_ADMISSION = value; };
