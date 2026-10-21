import type { ReactNode } from "react";
import { Card } from "@admin/components/ui/card";

/**
 * A list card of `SettingRow`s. Short controls (switches, values) always sit
 * on the right of their label; `wide` controls stack below it on narrow cards.
 */
export function SettingRows({ children }: { children: ReactNode }) {
  return (
    <Card variant="list" className="@container/rows">
      {children}
    </Card>
  );
}

/**
 * One label/control (or label/value) row inside `SettingRows`. `meta` is an
 * optional short line under the label (a range, a source, a state). `wide`
 * gives pickers and text inputs a fixed column so stacked rows align.
 */
export function SettingRow({
  label,
  htmlFor,
  labelId,
  meta,
  wide = false,
  disabled = false,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  labelId?: string;
  meta?: ReactNode;
  wide?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const Caption = htmlFor ? "label" : "span";
  return (
    <div
      data-disabled={disabled}
      data-wide={wide}
      className="group/row flex min-h-12 items-center justify-between gap-x-6 gap-y-2 px-4 py-2 data-[wide=true]:flex-col data-[wide=true]:items-stretch @md/rows:data-[wide=true]:flex-row @md/rows:data-[wide=true]:items-center"
    >
      <div className="flex min-w-0 grow basis-1/2 flex-col gap-0.5">
        <Caption
          htmlFor={htmlFor}
          id={labelId}
          className="flex min-w-0 items-center gap-3 text-sm group-data-[disabled=true]/row:opacity-50"
        >
          {label}
        </Caption>
        {meta && <span className="text-xs text-muted-foreground">{meta}</span>}
      </div>
      <div
        data-wide={wide}
        className="flex min-w-0 flex-col items-end gap-1.5 text-sm data-[wide=true]:w-full data-[wide=true]:items-stretch @md/rows:data-[wide=true]:w-72 @md/rows:data-[wide=true]:shrink-0"
      >
        {children}
      </div>
    </div>
  );
}

/** A read-only value in a `SettingRow`. */
export function SettingValue({ children }: { children: ReactNode }) {
  return (
    <span className="max-w-full min-w-0 truncate text-muted-foreground">
      {children}
    </span>
  );
}
