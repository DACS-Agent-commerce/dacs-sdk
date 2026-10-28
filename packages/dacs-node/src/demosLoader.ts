import { register } from "node:module";

// demosdk 4.0.16 publishes an extensionless ESM directory import on the websdk
// import path (demoswork/operations/; its others are off that path). Register a
// package-scoped resolver for that exact path so generated services do not need
// a general-purpose TypeScript transform loader in production. 4.0.17 and later
// import the directory's index.js explicitly, so the hook's fallback never
// triggers for them.
register(new URL("./demosLoaderHook.js", import.meta.url));
