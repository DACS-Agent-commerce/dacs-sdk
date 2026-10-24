import { testWallet } from './protocol-fixture.mjs';
let nextTestWallet = 30;
export const key = () => { const wallet = testWallet(nextTestWallet++); return { claim: wallet.claim, sign: wallet.signBytes }; };
