'use client';

import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, children, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(
        'h-9 w-full appearance-none rounded-lg border border-zinc-300 bg-white px-3 pr-8 text-sm text-zinc-900',
        'bg-[url("data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20width%3D%2712%27%20height%3D%2712%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27%2371717a%27%20stroke-width%3D%272%27%3E%3Cpath%20d%3D%27m6%209%206%206%206-6%27%2F%3E%3C%2Fsvg%3E")] bg-[position:right_0.6rem_center] bg-no-repeat',
        'focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-200',
        'disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-500',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
});
