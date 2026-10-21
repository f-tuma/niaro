import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@admin/components/ui/collapsible";

/**
 * Progressive disclosure for secondary or technical detail (identifiers,
 * revisions, raw JSON). Closed by default; the chevron turns when open.
 */
export function Disclosure({
  title,
  children,
  defaultOpen,
  open,
  onOpenChange,
}: {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  /** Controlled state, for forms that reveal the section on a validation error. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      open={open}
      onOpenChange={onOpenChange}
      className="group/disclosure"
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 h-auto max-w-full justify-start whitespace-normal text-left"
        >
          <ChevronRight
            data-icon="inline-start"
            aria-hidden="true"
            className="transition-transform group-data-open/disclosure:rotate-90 motion-reduce:transition-none"
          />
          {title}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** Raw technical data, for use inside a `Disclosure`. */
export function CodeBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs break-all whitespace-pre-wrap">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}
