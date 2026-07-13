'use client';

import type { LabelHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: generic wrapper — callers pass htmlFor via props
    <label className={cn('mb-1.5 block text-sm font-medium text-zinc-700', className)} {...props} />
  );
}
