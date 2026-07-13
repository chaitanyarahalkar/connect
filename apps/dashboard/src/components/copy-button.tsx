'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';

export function CopyButton({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // fallback for non-secure contexts
      const el = document.createElement('textarea');
      el.value = value;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title="Copy to clipboard"
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50',
        className,
      )}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/** A one-line code value with a copy button, for URLs / IDs / secrets. */
export function CopyField({ value, mono = true }: { value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
      <code
        className={cn('min-w-0 flex-1 truncate text-xs text-zinc-800', mono && 'font-mono')}
        title={value}
      >
        {value}
      </code>
      <CopyButton value={value} />
    </div>
  );
}
