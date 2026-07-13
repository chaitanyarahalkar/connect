'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiFetch } from './api';
import { useActiveOrgSlug } from './org-context';

export interface UseApiResult<T> {
  data: T | null;
  loading: boolean;
  error: ApiError | null;
  refetch: () => void;
}

/**
 * Small data-fetching hook. Pass `null` as the path to skip fetching
 * (e.g. while a dependency is still loading).
 */
export function useApi<T>(path: string | null): UseApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<ApiError | null>(null);
  const [tick, setTick] = useState(0);
  const generation = useRef(0);
  const orgSlug = useActiveOrgSlug();

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick and orgSlug intentionally re-trigger the fetch
  useEffect(() => {
    if (path === null) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    const gen = ++generation.current;
    setLoading(true);
    setError(null);
    apiFetch<T>(path)
      .then((result) => {
        if (generation.current !== gen) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (generation.current !== gen) return;
        setError(err instanceof ApiError ? err : new ApiError('internal_error', String(err), 0));
        setLoading(false);
      });
  }, [path, tick, orgSlug]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  return { data, loading, error, refetch };
}

export interface UseMutationResult<TInput, TOutput> {
  mutate: (input: TInput) => Promise<TOutput>;
  pending: boolean;
  error: ApiError | null;
  reset: () => void;
}

/** Wraps an async mutation with pending/error state. */
export function useMutation<TInput, TOutput>(
  fn: (input: TInput) => Promise<TOutput>,
): UseMutationResult<TInput, TOutput> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const mutate = useCallback(
    async (input: TInput): Promise<TOutput> => {
      setPending(true);
      setError(null);
      try {
        return await fn(input);
      } catch (err) {
        const apiErr =
          err instanceof ApiError ? err : new ApiError('internal_error', String(err), 0);
        setError(apiErr);
        throw apiErr;
      } finally {
        setPending(false);
      }
    },
    [fn],
  );

  const reset = useCallback(() => setError(null), []);

  return { mutate, pending, error, reset };
}
