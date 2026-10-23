// Run-time port of http-mcp/src/operations.mjs at DACS-Agent-commerce/frontend 15fdf23: lines
// 11-17.
// Left out: the application operation store; only its error class.
export class OperationError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
