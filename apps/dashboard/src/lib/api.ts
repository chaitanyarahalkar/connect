'use client';

export const API_URL = process.env.NEXT_PUBLIC_CONNECT_API_URL ?? 'http://localhost:4000';

const ORG_STORAGE_KEY = 'connect.activeOrgSlug';

export function getStoredOrgSlug(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(ORG_STORAGE_KEY);
}

export function storeOrgSlug(slug: string | null): void {
  if (typeof window === 'undefined') return;
  if (slug === null) window.localStorage.removeItem(ORG_STORAGE_KEY);
  else window.localStorage.setItem(ORG_STORAGE_KEY, slug);
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Override the org slug header (defaults to the persisted active org). */
  orgSlug?: string | null;
}

export async function apiFetch<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const orgSlug = options.orgSlug !== undefined ? options.orgSlug : getStoredOrgSlug();
  if (orgSlug) headers['x-connect-org'] = orgSlug;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: options.method ?? 'GET',
      credentials: 'include',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError('network_error', `Could not reach the Connect API at ${API_URL}`, 0);
  }

  if (!res.ok) {
    let code = 'internal_error';
    let message = `Request failed with status ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      // non-JSON error body; keep defaults
    }
    throw new ApiError(code, message, res.status);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
