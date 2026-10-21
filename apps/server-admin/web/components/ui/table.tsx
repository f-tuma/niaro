import * as React from "react";
import { cn } from "cn";

function Table({
  className,
  scroll = false,
  ...props
}: React.ComponentProps<"table"> & {
  /** The table scrolls inside its flex parent (with a sticky header). */
  scroll?: boolean;
}) {
  return (
    <div
      data-slot="table-container"
      data-scroll={scroll}
      className="relative w-full overflow-x-auto data-[scroll=true]:min-h-0 data-[scroll=true]:flex-1 data-[scroll=true]:overflow-y-auto"
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({
  className,
  sticky = false,
  ...props
}: React.ComponentProps<"thead"> & {
  /** Stays at the top while the table scrolls (`Table scroll`). */
  sticky?: boolean;
}) {
  return (
    <thead
      data-slot="table-header"
      data-sticky={sticky}
      className={cn(
        "[&_tr]:border-b data-[sticky=true]:sticky data-[sticky=true]:top-0 data-[sticky=true]:z-10 data-[sticky=true]:bg-card",
        className,
      )}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-accent/50 has-aria-expanded:bg-accent/50 data-[state=selected]:bg-accent data-[muted=true]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-9 px-3 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground first:pl-4 last:pr-4 [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "h-10 px-3 py-1.5 align-middle whitespace-nowrap first:pl-4 last:pr-4 [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
};
