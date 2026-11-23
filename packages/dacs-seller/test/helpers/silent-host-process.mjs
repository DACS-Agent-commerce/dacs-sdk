// Unshipped: a stand-in child for vetHostProcess (host-context-vet-fixture.mjs) that never reports a start. It names its pid on stderr,
// which the fixture puts in its startup error, and stays alive on its IPC channel until it is killed.
process.stderr.write(`TEST silent host process pid=${process.pid}\n`);
process.on('message', () => {});
