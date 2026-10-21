import type { ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";

const frame = cva(
  "flex shrink-0 items-center justify-center overflow-hidden border [&_img]:object-contain",
  {
    variants: {
      size: {
        sm: "size-7 rounded-md [&_svg]:size-4 [&_img]:size-4",
        md: "size-8 rounded-md [&_svg]:size-4 [&_img]:size-5",
        lg: "size-10 rounded-lg [&_svg]:size-5 [&_img]:size-6",
      },
      tone: {
        glyph: "border-transparent bg-glyph text-glyph-foreground",
        image: "bg-background",
        muted: "border-transparent bg-muted text-muted-foreground",
      },
    },
    defaultVariants: { size: "md", tone: "glyph" },
  },
);

/** Square identity mark for services, providers, plugins and workspaces. */
export function EntityIcon({
  children,
  size,
  tone,
}: { children: ReactNode } & VariantProps<typeof frame>) {
  return (
    <span aria-hidden="true" className={frame({ size, tone })}>
      {children}
    </span>
  );
}

/** Two-letter initials for workspaces, organizations and people. */
export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : name.slice(0, 2);
  return letters.toUpperCase();
}
