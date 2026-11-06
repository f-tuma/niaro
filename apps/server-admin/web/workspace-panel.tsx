import { createContext, useContext, type ReactNode } from "react";
import { cn } from "cn";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@admin/components/ui/sheet";

const Inline = createContext(false);
/** Whether the panel sits on the workspace page rather than in a sheet. */
export const usePanelInline = () => useContext(Inline);

/**
 * One workspace setting (members, roles, instructions, knowledge): a section
 * of the workspace page, or a side sheet where a page opens it as an action.
 */
export function WorkspacePanel({
  inline = false,
  open = true,
  onOpenChange,
  size = "wide",
  title,
  description,
  children,
}: {
  inline?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  size?: "form" | "wide";
  title: string;
  /** Shown under the sheet's title; the page names the workspace itself. */
  description?: string;
  children: ReactNode;
}) {
  if (inline)
    return (
      <Inline.Provider value>
        <div className="flex flex-col gap-4">{children}</div>
      </Inline.Provider>
    );
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent size={size}>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  );
}

/** The panel's scrolling body: padded and scrolling only inside a sheet. */
export function panelBody(inline: boolean, className?: string) {
  return cn(
    "flex flex-col",
    !inline && "min-h-0 flex-1 overflow-y-auto px-4 pb-4",
    className,
  );
}
/** `panelBody` for a component rendered inside the panel. */
export function usePanelBody(className?: string) {
  return panelBody(usePanelInline(), className);
}

/** The panel's buttons: a sheet footer, or a row under the section. */
export function PanelFooter({ children }: { children: ReactNode }) {
  const inline = usePanelInline();
  return inline ? (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
      {children}
    </div>
  ) : (
    <SheetFooter>{children}</SheetFooter>
  );
}
