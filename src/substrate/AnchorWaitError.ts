import { SubstrateError } from "../errors.js";
import type {
  AnchorAttemptReceipt,
  AnchorWaitFailureCode,
} from "./SubstrateAdapter.js";

/**
 * Reliable-anchor failure evidence. Callers can reconcile an ambiguous write
 * from the receipt without parsing a message or blindly rebroadcasting it.
 */
export class AnchorWaitError extends SubstrateError {
  readonly code: AnchorWaitFailureCode;
  readonly receipt: AnchorAttemptReceipt;

  constructor(
    code: AnchorWaitFailureCode,
    message: string,
    receipt: AnchorAttemptReceipt,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AnchorWaitError";
    this.code = code;
    this.receipt = receipt;
  }
}
