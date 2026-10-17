import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Badges: tinted fill, coloured mono text at 11px, the floor for text that is read. `default`
// is the signal: needs you.
const badgeVariants = cva(
  "inline-flex h-5 items-center justify-center gap-1.5 px-[7px] font-mono text-[11px] leading-none font-semibold tracking-[0.04em] uppercase w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 [&>svg]:pointer-events-none overflow-hidden",
  {
    variants: {
      variant: {
        default: "bg-primary-fill text-primary-fill-foreground",
        secondary: "bg-secondary text-muted-foreground",
        soft: "bg-primary-soft text-primary",
        ok: "bg-ok-soft text-ok",
        work: "bg-work-soft text-work",
        bad: "bg-bad-soft text-bad",
        outline: "border border-hair-strong text-muted-foreground",
        destructive: "bg-bad text-bad-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
