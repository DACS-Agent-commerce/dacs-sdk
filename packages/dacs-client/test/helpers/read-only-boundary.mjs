// The effect boundary for a transport that only reads. The transport requires one.
const unused = () => { throw new Error('TEST-this-transport-never-writes'); };

/** Every effect member refuses, so a test that writes through a read-only transport fails loudly. */
export const readOnlyBoundary = Object.freeze({ holdFence: unused, withOperation: unused, signPass: unused, dispatchPass: unused, signAuthentication: unused });
