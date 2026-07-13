import { createHash, createHmac } from 'node:crypto';
import { type KmsClient, KmsError } from './types.js';

/**
 * AWS KMS over its JSON REST API with hand-rolled SigV4 — no AWS SDK
 * dependency. Only Encrypt/Decrypt are needed (KEK wrapping), both of which
 * take small payloads well under KMS's 4 KiB plaintext limit.
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface AwsKmsClientOptions {
  /** KMS key id or ARN used for Encrypt. Decrypt infers the key from the ciphertext. */
  keyId: string;
  region: string;
  credentials: AwsCredentials;
  fetchImpl?: typeof fetch;
  /** Override the endpoint (tests, VPC endpoints). */
  endpoint?: string;
}

export class AwsKmsClient implements KmsClient {
  readonly provider = 'aws-kms';
  readonly keyId: string;
  private region: string;
  private credentials: AwsCredentials;
  private fetchImpl: typeof fetch;
  private endpoint: string;

  constructor(opts: AwsKmsClientOptions) {
    this.keyId = opts.keyId;
    this.region = opts.region;
    this.credentials = opts.credentials;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.endpoint = opts.endpoint ?? `https://kms.${opts.region}.amazonaws.com/`;
  }

  static fromEnv(keyId: string, env: NodeJS.ProcessEnv = process.env): AwsKmsClient {
    const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
    if (!region) throw new Error('AWS_REGION is not set');
    const accessKeyId = env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) {
      throw new Error('AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not set');
    }
    return new AwsKmsClient({
      keyId,
      region,
      credentials: { accessKeyId, secretAccessKey, sessionToken: env.AWS_SESSION_TOKEN },
    });
  }

  async encrypt(plaintext: Buffer): Promise<Buffer> {
    const res = await this.call('Encrypt', {
      KeyId: this.keyId,
      Plaintext: plaintext.toString('base64'),
    });
    return Buffer.from(res.CiphertextBlob as string, 'base64');
  }

  async decrypt(ciphertext: Buffer): Promise<Buffer> {
    const res = await this.call('Decrypt', {
      CiphertextBlob: ciphertext.toString('base64'),
    });
    return Buffer.from(res.Plaintext as string, 'base64');
  }

  private async call(
    action: 'Encrypt' | 'Decrypt',
    body: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const payload = JSON.stringify(body);
    const url = new URL(this.endpoint);
    const headers = signAwsRequest({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': `TrentService.${action}`,
      },
      body: payload,
      region: this.region,
      service: 'kms',
      credentials: this.credentials,
    });
    const res = await this.fetchImpl(url, { method: 'POST', headers, body: payload });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const op = action === 'Encrypt' ? 'encrypt' : 'decrypt';
      throw new KmsError(this.provider, op, String(raw.__type ?? raw.message ?? res.status));
    }
    return raw;
  }
}

/**
 * AWS Signature Version 4. Returns the input headers plus host, x-amz-date,
 * authorization and (when present) x-amz-security-token.
 * Exported for testing against the published SigV4 test vectors.
 */
export function signAwsRequest(params: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  date?: Date;
}): Record<string, string> {
  const { url, credentials } = params;
  const now = params.date ?? new Date();
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(params.headers).map(([k, v]) => [k.toLowerCase(), v])),
    host: url.host,
    'x-amz-date': amzDate,
  };
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name]!.trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    params.method.toUpperCase(),
    url.pathname || '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    sha256Hex(params.body),
  ].join('\n');

  const scope = `${dateStamp}/${params.region}/${params.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, params.region);
  const kService = hmac(kRegion, params.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

/** RFC 3986 encoding as SigV4 requires (encode everything but unreserved chars). */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}
