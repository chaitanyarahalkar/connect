import { errorFromResponse } from './errors.js';

/** Thin authenticated REST client for the Connect control plane (used by the CLI). */
export class ConnectClient {
  constructor(
    private opts: {
      baseUrl: string;
      auth: string;
      fetch?: typeof fetch;
    },
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const doFetch = this.opts.fetch ?? fetch;
    const res = await doFetch(`${this.opts.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.auth}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw errorFromResponse(res.status, await res.json().catch(() => null));
    return (await res.json()) as T;
  }

  get<T>(path: string) {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body?: unknown) {
    return this.request<T>('POST', path, body);
  }
  put<T>(path: string, body?: unknown) {
    return this.request<T>('PUT', path, body);
  }
  patch<T>(path: string, body?: unknown) {
    return this.request<T>('PATCH', path, body);
  }
  delete<T>(path: string) {
    return this.request<T>('DELETE', path);
  }
}
