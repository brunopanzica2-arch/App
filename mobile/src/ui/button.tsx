import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "./utils";

const button = cva(
  "inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
  {
    variants: {
      variant: {
        primary: "bg-brand text-white hover:bg-brand-dark",
        secondary: "card hover:bg-black/5 dark:hover:bg-white/5",
        success: "bg-done text-white hover:opacity-90",
        danger: "bg-problem text-white hover:opacity-90",
        ghost: "hover:bg-black/5 dark:hover:bg-white/10",
      },
      size: { sm: "h-9 px-3 text-sm", md: "h-11 px-4", lg: "h-14 px-5 text-lg", icon: "h-11 w-11" },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, ...p }, ref) => (
  <button ref={ref} className={cn(button({ variant, size }), className)} {...p} />
));
Button.displayName = "Button";
