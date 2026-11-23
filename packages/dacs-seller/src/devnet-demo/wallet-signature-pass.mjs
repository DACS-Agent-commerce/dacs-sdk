// The seller's operator-wallet signatures that are not CREATEs (the Listing, the identity presentation and the Vet component
// signatures), each made inside a pass of an issued runCreate, so the effect boundary's stop check and synchronous tail run
// right before the wallet is called.
import { isSellerCreatePass } from './create-pass.mjs';

// A retained signature is the wallet's own string form: unpadded base64url, or whatever printable text the wallet answered.
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

function passOf({ runCreate, operationId, lane, operationClass, currentAuthorization }) {
  if (!isSellerCreatePass(runCreate)) throw new TypeError('runCreate must be a pass that createSellerCreatePass or the wallet-session port issued');
  return { runCreate, input: { operationId, lane, operationClass, currentAuthorization } };
}

function encodeSignature(value) {
  if (typeof value !== 'string' || !PRINTABLE_ASCII.test(value)) throw new TypeError('the wallet signature must be a non-empty printable ASCII string');
  return Buffer.from(value, 'utf8');
}

/**
 * Makes one signature through the boundary's signPass in a pass of `op.runCreate` (`{ runCreate, operationId, lane,
 * operationClass, currentAuthorization }`), so its bytes are retained under `operationId` on `lane`. `signValue()` calls the
 * wallet once and resolves the signature's string form. Resolves the retained string when the lane already holds one for
 * `operationId` (the wallet is not called), else the new one. Rejects with a TypeError for a runCreate the kit did not issue
 * (before anything is called) or for a signature that is not a non-empty printable ASCII string (nothing is retained), with
 * the boundary's refusal, or with `signValue`'s own error.
 */
export async function signRetainedInPass(op, signValue) {
  const { runCreate, input } = passOf(op);
  const bytes = await runCreate(input, ({ signPass }) => signPass(async () => encodeSignature(await signValue())));
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Signs `bytes` with `sign` through the boundary's guarded signer in a pass of `op.runCreate` (same `op` as
 * signRetainedInPass); nothing is retained. Resolves `sign`'s answer. Rejects with a TypeError for a runCreate the kit did not
 * issue (before anything is called), with the boundary's refusal (before `sign` is called), or with `sign`'s own error.
 */
export async function signInPass(op, sign, bytes) {
  const { runCreate, input } = passOf(op);
  return runCreate(input, ({ guardedSigner }) => guardedSigner(sign)(bytes));
}
