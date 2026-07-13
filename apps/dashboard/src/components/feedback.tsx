'use client';

import type { ReactNode } from 'react';
import type { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-zinc-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600" />
      {label ?? 'Loading…'}
    </div>
  );
}

export function ErrorText({
  error,
  onRetry,
}: {
  error: ApiError | Error | string | null;
  onRetry?: () => void;
}) {
  if (!error) return null;
  const message = typeof error === 'string' ? error : error.message;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-zinc-300 bg-zinc-50/50 px-6 py-12 text-center">
      <p className="text-sm font-medium text-zinc-800">{title}</p>
      {description ? <p className="max-w-sm text-sm text-zinc-500">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
