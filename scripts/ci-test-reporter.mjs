// node:test reporter for scripts/ci-test-names.mjs (--test-reporter=<this file>), kept in its own module.

/**
 * One JSON line per top-level test that ran, {"name", "ok"}.
 * Skipped and todo tests are left out, so the lines are the tests that actually ran.
 */
export default async function* ranTests(source) {
  for await (const event of source) {
    if ((event.type !== "test:pass" && event.type !== "test:fail") || event.data.nesting !== 0) continue;
    if (event.data.skip !== undefined || event.data.todo !== undefined) continue;
    yield `${JSON.stringify({ name: event.data.name, ok: event.type === "test:pass" })}\n`;
  }
}
