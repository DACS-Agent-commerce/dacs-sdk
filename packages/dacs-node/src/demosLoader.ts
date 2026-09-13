import { register } from "node:module";

// demosdk 4.0.16 publishes one extensionless ESM directory import. Register a
// package-scoped resolver for that exact path so generated services do not need
// a general-purpose TypeScript transform loader in production.
register(new URL("./demosLoaderHook.js", import.meta.url));
