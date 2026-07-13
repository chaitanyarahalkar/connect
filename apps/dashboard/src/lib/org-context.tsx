'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { ApiError, apiFetch, getStoredOrgSlug, storeOrgSlug } from './api';
import type { Org } from './types';

interface OrgContextValue {
  orgs: Org[];
  activeOrg: Org | null;
  loading: boolean;
  error: ApiError | null;
  setActiveOrg: (slug: string) => void;
  refetchOrgs: () => Promise<void>;
}

const OrgContext = createContext<OrgContextValue | null>(null);

export function OrgProvider({ children }: { children: ReactNode }) {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ organizations: Org[] }>('/v1/orgs', { orgSlug: null });
      setOrgs(res.organizations);
      const stored = getStoredOrgSlug();
      const first = res.organizations[0];
      const valid = res.organizations.find((o) => o.slug === stored);
      const next = valid?.slug ?? first?.slug ?? null;
      setActiveSlug(next);
      storeOrgSlug(next);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError('internal_error', String(err), 0));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setActiveOrg = useCallback((slug: string) => {
    storeOrgSlug(slug);
    setActiveSlug(slug);
  }, []);

  const value = useMemo<OrgContextValue>(
    () => ({
      orgs,
      activeOrg: orgs.find((o) => o.slug === activeSlug) ?? null,
      loading,
      error,
      setActiveOrg,
      refetchOrgs: load,
    }),
    [orgs, activeSlug, loading, error, setActiveOrg, load],
  );

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgContextValue {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error('useOrg must be used within an OrgProvider');
  return ctx;
}

/** Safe (non-throwing) read of the active org slug; null outside an OrgProvider. */
export function useActiveOrgSlug(): string | null {
  const ctx = useContext(OrgContext);
  return ctx?.activeOrg?.slug ?? null;
}
