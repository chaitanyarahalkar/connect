const SENSITIVE_KEY = /(authorization|token|secret|password|api[-_]?key|client[-_]?secret|assertion|code|cookie|set-cookie|private[-_]?key)/i;

/**
 * Recursively redacts values whose keys look sensitive. Used before storing
 * webhook headers, audit metadata, and in log serializers. Never mutates input.
 */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1)) as unknown as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** Shows the first `visible` chars of a secret for display: "ghs_ab…" */
export function redactToken(token: string, visible = 8): string {
  if (token.length <= visible) return '…';
  return `${token.slice(0, visible)}…`;
}
