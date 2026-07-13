/** True when err (or its cause chain) is a Postgres unique violation on the given constraint. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  let current: unknown = err;
  for (let i = 0; i < 5 && current; i++) {
    const e = current as {
      code?: string;
      constraint_name?: string;
      constraint?: string;
      cause?: unknown;
    };
    if (e.code === '23505') {
      if (!constraint) return true;
      return e.constraint_name === constraint || e.constraint === constraint;
    }
    current = e.cause;
  }
  return false;
}
