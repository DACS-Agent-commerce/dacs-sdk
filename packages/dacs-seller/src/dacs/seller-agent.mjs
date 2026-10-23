// Shared transport refusal; the agent constructor is introduced separately.
export class SellerAgentError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
