import { useState, type ReactNode } from "react";
import { MoreHorizontal, Search } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@admin/components/ui/dropdown-menu";
import { Button } from "@admin/components/ui/button";
import { Spinner } from "@admin/components/ui/spinner";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@admin/components/ui/input-group";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@admin/components/ui/alert-dialog";

export function SearchField({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label?: string;
}) {
  return (
    <InputGroup>
      <InputGroupAddon>
        <Search aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
      />
    </InputGroup>
  );
}

/**
 * Sticky footer for editable pages. The status slot shows one short word
 * (Unsaved changes / Saved / an error) instead of paragraphs.
 */
export function SaveBar({
  status,
  tone = "muted",
  children,
}: {
  status?: ReactNode;
  tone?: "muted" | "error" | "success";
  children: ReactNode;
}) {
  return (
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-2 border-t bg-background/95 py-2.5 backdrop-blur-sm">
      {status && (
        <p
          role="status"
          data-tone={tone}
          className="mr-auto text-sm text-muted-foreground data-[tone=error]:text-destructive data-[tone=success]:text-success"
        >
          {status}
        </p>
      )}
      {children}
    </div>
  );
}

/** Primary submit button with a pending spinner. */
export function SubmitButton({
  pending,
  disabled,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { pending?: boolean }) {
  return (
    <Button type="submit" {...props} disabled={pending || disabled}>
      {pending && <Spinner data-icon="inline-start" />}
      {children}
    </Button>
  );
}

/** Every destructive action goes through this confirmation. */
export function ConfirmAction({
  trigger,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  open: controlledOpen,
  onOpenChange,
}: {
  /** Omit when opened from a menu item; pass open/onOpenChange instead. */
  trigger?: ReactNode;
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void | Promise<unknown>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      {trigger && <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              setOpen(false);
              void onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Read-only label/value pairs. Labels sit in one fixed-width column
 * (`--detail-columns`) so values start at the same x on every page, and each
 * pair shares a text baseline even when the value is a badge or code.
 */
export function DetailList({
  items,
  stacked = false,
}: {
  items: { label: string; value: ReactNode }[];
  stacked?: boolean;
}) {
  return (
    <dl
      data-stacked={stacked}
      className="grid grid-cols-1 items-baseline gap-x-6 gap-y-3 text-sm sm:grid-cols-(--detail-columns) sm:gap-y-2.5 data-[stacked=true]:grid-cols-1"
    >
      {items.map((item) => (
        <div
          key={item.label}
          data-stacked={stacked}
          className="flex min-w-0 flex-col gap-0.5 sm:contents data-[stacked=true]:flex"
        >
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className="min-w-0 break-words">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Overflow menu for secondary and destructive actions of a page or row. */
export function MoreActions({
  label,
  children,
  size = "default",
}: {
  label: string;
  children: ReactNode;
  /** `sm` inside list rows and table cells; `default` in page headers. */
  size?: "default" | "sm";
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size={size === "sm" ? "icon-sm" : "icon"}
          aria-label={label}
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
