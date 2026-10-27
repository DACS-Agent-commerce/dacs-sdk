// The crash and restart checkpoints, with the statement iterators of the engine
// floors in this process and in every worker process it starts.
const preload = new URL('./helpers/sqlite-floor-iterators-preload.mjs', import.meta.url).href;
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import ${preload}`].filter(Boolean).join(' ');

await import(preload);
await import('./domain-store-crash.test.mjs');
