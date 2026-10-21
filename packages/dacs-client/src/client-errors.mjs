import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
export class OperationError extends Error {
  constructor(code, message, details) { super(message); this.name = 'OperationError'; this.code = code; this.details = details; }
}
export class NotWiredError extends OperationError {
  constructor(seam) { super('client_not_wired', seam + ' is not wired; D11 must supply this integration'); this.name = 'NotWiredError'; this.seam = seam; }
}
export const requestHashOf = request => sha256Hex(canonicalize(request));
