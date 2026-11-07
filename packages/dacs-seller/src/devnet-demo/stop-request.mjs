// Run-time port of http-mcp/src/devnet-demo/stop-request.mjs at DACS-Agent-commerce/frontend
// 15fdf23: the whole file.
// The compose CLI's stop flag, set once SIGINT or SIGTERM starts its shutdown.
// Import-free, so the CLI loads it before it installs its handlers. A Listing
// publication reads it just before its CREATE intent would be journaled, and
// after a stop withdraws: no intent is stored and nothing is sent. Past that
// point the stop declines the Listing's APPROVE prompt (stopSignal), whether it
// is still to come or already waiting, so nothing is signed or sent either.
const stopping=new AbortController();
export const requestStop=()=>{stopping.abort();};
export const stopRequested=()=>stopping.signal.aborted;
export const stopSignal=stopping.signal;
