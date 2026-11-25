// What a refusal answer says about its cause. A refusal body is exactly `{ error, message }` (the shape the key's read-only
// role signs), and a cause travels at the end of its message as ` (cause: <cause>)`.
const CAUSE_AT_END = / \(cause: ([^()]*)\)$/;

/** The cause inside the final `(cause: …)` of `body.message`; undefined when there is none or `body` has any other member. */
export function causeOf(body) {
  if (body === null || typeof body !== 'object' || Object.keys(body).some((name) => name !== 'error' && name !== 'message')) return undefined;
  return typeof body.message === 'string' ? CAUSE_AT_END.exec(body.message)?.[1] : undefined;
}
