import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VerificationResult {
  valid: boolean;
  reason?: string;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** GitHub: X-Hub-Signature-256: sha256=HMAC_SHA256(secret, rawBody) */
export function verifyGithubSignature(
  rawBody: Buffer,
  headers: Record<string, string | undefined>,
  secret: string,
): VerificationResult {
  const header = headers['x-hub-signature-256'];
  if (!header) return { valid: false, reason: 'missing x-hub-signature-256' };
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return safeEqual(header, expected)
    ? { valid: true }
    : { valid: false, reason: 'signature mismatch' };
}

/** Slack: v0=HMAC_SHA256(secret, "v0:{timestamp}:{rawBody}"), ±5 min window. */
export function verifySlackSignature(
  rawBody: Buffer,
  headers: Record<string, string | undefined>,
  secret: string,
  now: number = Date.now(),
): VerificationResult {
  const timestamp = headers['x-slack-request-timestamp'];
  const signature = headers['x-slack-signature'];
  if (!timestamp || !signature) return { valid: false, reason: 'missing slack headers' };
  const age = Math.abs(now / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return { valid: false, reason: 'timestamp outside window' };
  const base = `v0:${timestamp}:${rawBody.toString('utf8')}`;
  const expected = `v0=${createHmac('sha256', secret).update(base).digest('hex')}`;
  return safeEqual(signature, expected)
    ? { valid: true }
    : { valid: false, reason: 'signature mismatch' };
}

/** Generic: sha256=HMAC_SHA256(secret, rawBody) in one of the accepted headers. */
export function verifyGenericSignature(
  rawBody: Buffer,
  headers: Record<string, string | undefined>,
  secret: string,
): VerificationResult {
  const header = headers['x-webhook-signature'] ?? headers['x-connect-signature'] ?? headers['x-mock-signature'];
  if (!header) return { valid: false, reason: 'missing signature header' };
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return safeEqual(header, expected)
    ? { valid: true }
    : { valid: false, reason: 'signature mismatch' };
}

/** Signature Connect adds to forwarded deliveries so destinations can verify us. */
export function signForwardedPayload(payload: string | Buffer, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}
