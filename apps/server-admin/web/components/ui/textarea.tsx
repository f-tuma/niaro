import * as React from "react";
import { cn } from "cn";

function Textarea({
  className,
  mono = false,
  ...props
}: React.ComponentProps<"textarea"> & {
  /** Monospace, compact text for JSON and code. */
  mono?: boolean;
}) {
  return (
    <textarea
      data-slot="textarea"
      data-mono={mono}
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/20 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-[mono=true]:font-mono data-[mono=true]:text-xs md:data-[mono=true]:text-xs",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
