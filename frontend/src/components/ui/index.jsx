/**
 * The shadcn style component set, in plain JSX.
 *
 * These are the shadcn/ui primitives (same anatomy, same variant names, same
 * token based colours) written without the Radix dependencies this project
 * does not need yet. They are the building blocks for the signed-in screens:
 * dashboard, wallet, settlement rail. Nothing here fetches, formats money or
 * knows about the domain.
 *
 * Every component renders inside a `.ui` subtree, which is where the scoped
 * reset in ui.css applies. Pages that have not been converted keep their own
 * styling untouched.
 */
import React from 'react'
import { cva } from 'class-variance-authority'
import { cn } from '../../lib/cn.js'

/* ------------------------------------------------------------------ Button */

const buttonVariants = cva(
  'ui inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold ' +
    'transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ' +
    'disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        outline: 'border border-input bg-card text-foreground hover:bg-accent hover:text-accent-foreground',
        ghost: 'text-foreground hover:bg-accent hover:text-accent-foreground',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        link: 'text-primary underline underline-offset-4 hover:no-underline',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        default: 'h-9 px-4',
        lg: 'h-11 px-6 text-[15px]',
        icon: 'h-9 w-9 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export function Button({ className, variant, size, asChild = false, ...props }) {
  const Comp = asChild ? 'span' : 'button'
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
export { buttonVariants }

/* -------------------------------------------------------------------- Card */

export function Card({ className, ...props }) {
  return (
    <div
      className={cn('ui rounded-lg border border-border bg-card text-card-foreground shadow-xs', className)}
      {...props}
    />
  )
}
export function CardHeader({ className, ...props }) {
  return <div className={cn('flex flex-col gap-1 px-5 pt-5 pb-3', className)} {...props} />
}
export function CardTitle({ className, ...props }) {
  return <h3 className={cn('text-[15px] font-bold tracking-tight text-foreground', className)} {...props} />
}
export function CardDescription({ className, ...props }) {
  return <p className={cn('text-[12.5px] leading-relaxed text-muted-foreground', className)} {...props} />
}
export function CardAction({ className, ...props }) {
  return <div className={cn('absolute right-5 top-5 flex items-center gap-2', className)} {...props} />
}
export function CardContent({ className, ...props }) {
  return <div className={cn('px-5 pb-5 text-[13.5px] leading-relaxed', className)} {...props} />
}
export function CardFooter({ className, ...props }) {
  return <div className={cn('flex items-center gap-2 border-t border-border px-5 py-3', className)} {...props} />
}

/* ------------------------------------------------------------------- Badge */

const badgeVariants = cva(
  'ui inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-bold ' +
    'uppercase tracking-wide whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-border bg-secondary text-secondary-foreground',
        outline: 'border-border bg-card text-muted-foreground',
        success: 'border-[#A7F3D0] bg-[#ECFDF5] text-[#047857]',
        warning: 'border-[#FDE68A] bg-[#FFFBEB] text-[#B45309]',
        destructive: 'border-[#FECACA] bg-[#FEF2F2] text-[#B91C1C]',
        /* Simulated things must never look like settled ones. */
        simulated: 'border-[#DDD6FE] bg-[#F5F3FF] text-[#6D28D9]',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export function Badge({ className, variant, ...props }) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
export { badgeVariants }

/* ------------------------------------------------------- Input / Label etc */

export function Input({ className, ...props }) {
  return (
    <input
      className={cn(
        'ui h-9 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground',
        'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2',
        'focus-visible:ring-[var(--ring)] disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export function Label({ className, ...props }) {
  return (
    <label
      className={cn('ui block text-[11px] font-bold uppercase tracking-wide text-muted-foreground', className)}
      {...props}
    />
  )
}

export function Select({ className, children, ...props }) {
  return (
    <select
      className={cn(
        'ui h-9 w-full rounded-md border border-input bg-card px-2.5 text-sm text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  )
}

export function Separator({ className, ...props }) {
  return <div role="separator" className={cn('ui h-px w-full bg-border', className)} {...props} />
}

export function Skeleton({ className, ...props }) {
  return <div className={cn('ui animate-pulse rounded-md bg-muted', className)} {...props} />
}

/* ------------------------------------------------------------------- Table */

export function Table({ className, ...props }) {
  return (
    <div className="ui w-full overflow-x-auto">
      <table className={cn('w-full caption-bottom text-[13px]', className)} {...props} />
    </div>
  )
}
export function TableHeader({ className, ...props }) {
  return <thead className={cn('[&_tr]:border-b [&_tr]:border-border', className)} {...props} />
}
export function TableBody({ className, ...props }) {
  return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />
}
export function TableRow({ className, ...props }) {
  return <tr className={cn('border-b border-border transition-colors hover:bg-muted/60', className)} {...props} />
}
export function TableHead({ className, ...props }) {
  return (
    <th
      className={cn(
        'h-9 px-3 text-left align-middle text-[11px] font-bold uppercase tracking-wide text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}
export function TableCell({ className, ...props }) {
  return <td className={cn('px-3 py-2.5 align-middle', className)} {...props} />
}
export function TableEmpty({ colSpan, children }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="py-8 text-center text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
  )
}

/* -------------------------------------------------------------------- Tabs */

export function Tabs({ value, onValueChange, items = [], className }) {
  return (
    <div className={cn('ui inline-flex items-center gap-1 rounded-lg bg-muted p-1', className)} role="tablist">
      {items.map((item) => {
        const active = item.value === value
        return (
          <button
            key={item.value}
            role="tab"
            aria-selected={active}
            onClick={() => onValueChange(item.value)}
            className={cn(
              'rounded-md px-3 py-1.5 text-[13px] font-semibold transition-colors',
              active ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------- Alert */

const alertVariants = cva('ui rounded-lg border px-4 py-3 text-[13px] leading-relaxed', {
  variants: {
    variant: {
      default: 'border-border bg-card text-foreground',
      info: 'border-[#BFDBFE] bg-[#EFF6FF] text-[#1E40AF]',
      warning: 'border-[#FDE68A] bg-[#FFFBEB] text-[#92400E]',
      destructive: 'border-[#FECACA] bg-[#FEF2F2] text-[#991B1B]',
      success: 'border-[#A7F3D0] bg-[#ECFDF5] text-[#065F46]',
    },
  },
  defaultVariants: { variant: 'default' },
})

export function Alert({ className, variant, ...props }) {
  return <div role="status" className={cn(alertVariants({ variant }), className)} {...props} />
}
export function AlertTitle({ className, ...props }) {
  return <div className={cn('mb-0.5 font-bold', className)} {...props} />
}

/* --------------------------------------------------------------- Stat tile */

/** A number with its label, used across the dashboard, wallet and rail. */
export function Stat({ label, value, hint, tone = 'default', className }) {
  const toneClass = {
    default: 'text-foreground',
    success: 'text-[#047857]',
    warning: 'text-[#B45309]',
    destructive: 'text-[#B91C1C]',
  }[tone]
  return (
    <Card className={cn('px-4 py-3.5', className)}>
      <div className="text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn('mt-1 font-display text-[22px] leading-tight font-semibold', toneClass)}>{value}</div>
      {hint && <div className="mt-1 text-[11.5px] text-muted-foreground">{hint}</div>}
    </Card>
  )
}
