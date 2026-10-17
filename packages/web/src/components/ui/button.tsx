import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Buttons: square, ink outline, semibold; `default` is the signal colour that answers "needs you".
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-[13px] font-semibold transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          "border border-primary-fill bg-primary-fill text-primary-fill-foreground hover:brightness-110",
        ink: "border border-ink-line bg-ink text-ink-foreground hover:bg-ink/85",
        destructive: "border border-bad bg-bad text-bad-foreground hover:bg-bad/90",
        outline: "border border-ink-line bg-card text-foreground hover:bg-secondary",
        secondary:
          "border border-hair-strong bg-secondary text-secondary-foreground hover:border-ink-line",
        ghost: "text-muted-foreground hover:bg-secondary hover:text-foreground",
        link: "px-1! font-medium text-muted-foreground underline underline-offset-3 hover:text-foreground",
      },
      size: {
        default: "h-8 px-3.5 has-[>svg]:px-3",
        sm: "h-[26px] gap-1.5 px-2.5 text-xs has-[>svg]:px-2",
        lg: "h-10 px-5 has-[>svg]:px-4",
        icon: "size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
