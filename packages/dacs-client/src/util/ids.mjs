import { randomBytes, createHash } from 'node:crypto';

export function newId(prefix) {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function nowIso(now = Date.now) {
  return new Date(now()).toISOString();
}
