import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
export class OperationError extends Error {
  constructor(code, message, details, options) { super(message, options); this.name = 'OperationError'; this.code = code; this.details = details; }
}
export class NotWiredError extends OperationError {
  constructor(seam) { super('client_not_wired', seam + ' is not wired; D11 must supply this integration'); this.name = 'NotWiredError'; this.seam = seam; }
}
/** The codes a stop refusal carries: the host's stop check answered stopped, threw or rejected, stalled, or answered something that is not a boolean. */
export const STOP_REFUSAL_CODES = new Set(['writes_stopped', 'stop_check_failed', 'stop_check_invalid', 'stop_check_timeout']);
/** isStopRefusal(error) returns whether `error` is one of the stop refusals above. It does not throw. */
export const isStopRefusal = error => STOP_REFUSAL_CODES.has(error?.code);
export const requestHashOf =request => sha256Hex(canonicalize(request));
