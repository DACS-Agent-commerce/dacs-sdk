import type { DurableRfqLifecycleRecord } from "../../src/index.js";

/** Records whose nested members are primitives or null where the validator expects objects. */
export function malformedNestedRecords(base: DurableRfqLifecycleRecord<string>): Array<[string, unknown]> {
  const withMember = (key: string, value: unknown) => ({ ...structuredClone(base), [key]: value });
  const cases: Array<[string, unknown]> = [];
  for (const value of [null, 5, "x", true]) {
    const spelled = JSON.stringify(value);
    cases.push([`session ${spelled}`, withMember("session", value)]);
    cases.push([`authority ${spelled}`, withMember("authority", value)]);
    cases.push([`agreement ${spelled}`, withMember("agreement", value)]);
    cases.push([`transcript turn ${spelled}`, withMember("transcript", [value, ...structuredClone(base.transcript).slice(1)])]);
    cases.push([`outbox ${spelled}`, withMember("outbox", value)]);
    cases.push([`outbox entry ${spelled}`, withMember("outbox", [value])]);
    cases.push([`outbox packet ${spelled}`, withMember("outbox", [{ ...structuredClone(base.outbox[0]!), packet: value }])]);
    cases.push([`session buyer ${spelled}`, withMember("session", { ...structuredClone(base.session), buyer: value })]);
  }
  cases.push(["session buyer {}", withMember("session", { ...structuredClone(base.session), buyer: {} })]);
  return cases;
}
