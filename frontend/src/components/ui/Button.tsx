import { ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/utils/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  isLoading?: boolean;
}

const variants: Record<Variant, string> = {
  primary:
    "bg-signal-600 text-white hover:bg-signal-700 active:bg-signal-700 disabled:bg-signal-600/50",
  secondary:
    "bg-transparent text-ink-light dark:text-ink-dark border border-border-light dark:border-border-dark hover:bg-black/[.03] dark:hover:bg-white/[.04]",
  ghost:
    "bg-transparent text-muted-light dark:text-muted-dark hover:text-ink-light dark:hover:text-ink-dark hover:bg-black/[.03] dark:hover:bg-white/[.04]",
  danger: "bg-red-600 text-white hover:bg-red-700",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-sm gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-12 px-5 text-base gap-2",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant = "primary", size = "md", isLoading, disabled, children, ...props },
    ref
  ) => {
    return (
      <button
        ref={ref}
        disabled={disabled || isLoading}
        className={cn(
          "inline-flex items-center justify-center rounded-md font-medium transition-colors duration-150",
          "disabled:cursor-not-allowed disabled:opacity-60",
          variants[variant],
          sizes[size],
          className
        )}
        {...props}
      >
        {isLoading && (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
        )}
        {children}
      </button>
    );
  }
);
Button.displayName = "Button";
