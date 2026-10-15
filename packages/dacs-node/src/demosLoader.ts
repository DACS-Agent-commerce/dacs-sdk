import { register } from "node:module";

// demosdk 4.0.16 publishes one extensionless ESM directory import. Register a
// package-scoped resolver for that exact path so generated services do not need
// a general-purpose TypeScript transform loader in production. 4.0.17 and later
// import the directory's index.js explicitly, so the hook never fires for them.
register(new URL("./demosLoaderHook.js", import.meta.url));
