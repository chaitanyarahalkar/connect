import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  signForwardedPayload,
  verifyGenericSignature,
  verifyGithubSignature,
  verifySlackSignature,
} from '../src/webhooks/verify.js';

const body = Buffer.from(JSON.stringify({ action: 'opened', number: 1 }));

describe('github signatures', () => {
  const secret = "It's a Secret to Everybody";

  it('accepts a correctly signed payload', () => {
    const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    expect(verifyGithubSignature(body, { 'x-hub-signature-256': sig }, secret).valid).toBe(true);
  });

  it('rejects a wrong secret and a missing header', () => {
    const sig = `sha256=${createHmac('sha256', 'other').update(body).digest('hex')}`;
    expect(verifyGithubSignature(body, { 'x-hub-signature-256': sig }, secret).valid).toBe(false);
    expect(verifyGithubSignature(body, {}, secret).valid).toBe(false);
  });

  it('rejects a tampered body', () => {
    const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const tampered = Buffer.from(body.toString().replace('opened', 'closed'));
    expect(verifyGithubSignature(tampered, { 'x-hub-signature-256': sig }, secret).valid).toBe(
      false,
    );
  });
});

describe('slack signatures', () => {
  const secret = '8f742231b10e8888abcd99yyyzzz85a5';

  function slackHeaders(ts: number, raw: Buffer, sec = secret) {
    const base = `v0:${ts}:${raw.toString('utf8')}`;
    return {
      'x-slack-request-timestamp': String(ts),
      'x-slack-signature': `v0=${createHmac('sha256', sec).update(base).digest('hex')}`,
    };
  }

  it('accepts a fresh, correctly signed payload', () => {
    const now = Date.now();
    const ts = Math.floor(now / 1000);
    expect(verifySlackSignature(body, slackHeaders(ts, body), secret, now).valid).toBe(true);
  });

  it('rejects timestamps outside the 5-minute window (replay defense)', () => {
    const now = Date.now();
    const stale = Math.floor(now / 1000) - 600;
    const res = verifySlackSignature(body, slackHeaders(stale, body), secret, now);
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/window/);
  });

  it('rejects a wrong signing secret', () => {
    const now = Date.now();
    const ts = Math.floor(now / 1000);
    expect(verifySlackSignature(body, slackHeaders(ts, body, 'wrong'), secret, now).valid).toBe(
      false,
    );
  });
});

describe('generic + forwarded signatures', () => {
  it('round-trips: signForwardedPayload output verifies as a generic signature', () => {
    const sig = signForwardedPayload(body, 'whsec_abc');
    expect(verifyGenericSignature(body, { 'x-webhook-signature': sig }, 'whsec_abc').valid).toBe(
      true,
    );
    expect(verifyGenericSignature(body, { 'x-webhook-signature': sig }, 'whsec_other').valid).toBe(
      false,
    );
  });

  it('accepts alternate header names', () => {
    const sig = signForwardedPayload(body, 's');
    expect(verifyGenericSignature(body, { 'x-mock-signature': sig }, 's').valid).toBe(true);
    expect(verifyGenericSignature(body, { 'x-connect-signature': sig }, 's').valid).toBe(true);
  });
});
