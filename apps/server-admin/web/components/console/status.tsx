import type { ReactNode } from "react";
import { cva } from "class-variance-authority";
import { Badge } from "@admin/components/ui/badge";

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

const badgeVariant = {
  success: "success",
  warning: "warning",
  danger: "destructive",
  info: "info",
  neutral: "secondary",
} as const;

const dot = cva("size-1.5 shrink-0 rounded-full", {
  variants: {
    tone: {
      success: "bg-success",
      warning: "bg-warning",
      danger: "bg-destructive",
      info: "bg-info",
      neutral: "bg-muted-foreground",
    },
  },
});

/** The only way to show state: enabled, draft, expired, failed… */
export function StatusBadge({
  tone,
  children,
}: {
  tone: Tone;
  children: ReactNode;
}) {
  return (
    <Badge variant={badgeVariant[tone]}>
      <span aria-hidden="true" className={dot({ tone })} />
      {children}
    </Badge>
  );
}

/** Inline state without a pill, for dense tables and summaries. */
export function StatusDot({
  tone,
  children,
  size = "default",
}: {
  tone: Tone;
  children: ReactNode;
  /** `sm` inside meta lines (12 px). */
  size?: "default" | "sm";
}) {
  return (
    <span
      data-size={size}
      className="inline-flex items-center gap-2 text-sm data-[size=sm]:gap-1.5 data-[size=sm]:text-xs"
    >
      <span aria-hidden="true" className={dot({ tone })} />
      {children}
    </span>
  );
}
