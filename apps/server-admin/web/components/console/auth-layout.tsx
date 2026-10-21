import type { ReactNode } from "react";
import { Terminal } from "lucide-react";
import { Card, CardContent } from "@admin/components/ui/card";

/**
 * Centered single-task layout for pages outside the console shell:
 * sign-in, device approval and service connection. One card holds the mark,
 * the title, the form and its primary action; quiet links sit below it.
 */
export function AuthLayout({
  title,
  description,
  icon,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  /** Replaces the product mark, e.g. a check once a task is done. */
  icon?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-muted p-4 sm:p-10">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <Card>
          <CardContent>
            <div className="flex flex-col gap-6 py-2 sm:p-4">
              <header className="flex flex-col items-center gap-4 text-center">
                <span
                  aria-hidden="true"
                  className="flex size-10 items-center justify-center rounded-lg bg-foreground text-background [&_svg]:size-5"
                >
                  {icon ?? <Terminal />}
                </span>
                <div className="flex flex-col gap-1">
                  <h1 className="text-lg font-semibold tracking-tight text-balance">
                    {title}
                  </h1>
                  {description && (
                    <p className="text-sm text-balance text-muted-foreground">
                      {description}
                    </p>
                  )}
                </div>
              </header>
              {children}
            </div>
          </CardContent>
        </Card>
        {footer && (
          <div className="flex flex-col items-center gap-1 text-center">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/** "or" divider between sign-in methods. */
export function AuthDivider({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      {children}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
