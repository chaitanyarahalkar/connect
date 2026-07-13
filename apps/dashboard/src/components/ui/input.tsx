'use client';

import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-9 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900',
        'placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-200',
        'disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-500',
        className,
      )}
      {...props}
    />
  );
});
