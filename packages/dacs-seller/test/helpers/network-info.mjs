// The getNetworkInfo answer of a node whose signature-domain fork is inactive: transactions are signed over the bare hash.
export const INACTIVE_FORK_NETWORK_INFO = Object.freeze({ forks: Object.freeze({ osDenomination: Object.freeze({ activated: true }) }) });

/** A readNetworkInfo for a wallet journal over a node with the signature-domain fork inactive. */
export const readInactiveForkNetworkInfo = async () => INACTIVE_FORK_NETWORK_INFO;
