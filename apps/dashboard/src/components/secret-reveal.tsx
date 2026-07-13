'use client';

import { useState } from 'react';
import { CopyButton } from '@/components/copy-button';

/** Renders a secret redacted by default with a reveal toggle and copy button. */
export function SecretReveal({ value }: { value: string }) {
  const [revealed, setRevealed] = useState(false);
  const redacted =
    value.length > 12 ? `${value.slice(0, 6)}${'•'.repeat(18)}${value.slice(-4)}` : '•'.repeat(20);

  return (
    <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-800">
        {revealed ? value : redacted}
      </code>
      <button
        type="button"
        onClick={() => setRevealed((r) => !r)}
        className="inline-flex h-7 items-center rounded-md border border-zinc-200 bg-white px-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50"
      >
        {revealed ? 'Hide' : 'Reveal'}
      </button>
      <CopyButton value={value} />
    </div>
  );
}
