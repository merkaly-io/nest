import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignatureInput = string | Buffer;

export interface HmacOptions {
  algorithm?: string; // default sha256
  encoding?: 'hex' | 'base64' | 'base64url'; // default hex
}

export function safeCompare(received: SignatureInput | null | undefined, expected: SignatureInput) {
  if (received == null || !expected?.length) return false; // missing never matches

  const a = Buffer.from(received);
  const b = Buffer.from(expected);

  return a.length === b.length && timingSafeEqual(a, b);
}

export function hmacDigest(
  payload: SignatureInput,
  secret: SignatureInput,
  options: HmacOptions = {},
) {
  const { algorithm = 'sha256', encoding = 'hex' } = options;

  return createHmac(algorithm, secret).update(payload).digest(encoding);
}

export function verifyHmac(
  payload: SignatureInput,
  signature: SignatureInput | null | undefined,
  secret: SignatureInput,
  options: HmacOptions = {},
) {
  return safeCompare(signature, hmacDigest(payload, secret, options));
}
