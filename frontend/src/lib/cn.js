import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** The shadcn class helper: conditional classes, with later utilities winning. */
export function cn(...inputs) {
  return twMerge(clsx(inputs))
}
