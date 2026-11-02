// Shared transport error identity without loading seller state.
export class SellerAgentError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
