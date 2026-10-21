import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Link, type LinkProps } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Button } from "@admin/components/ui/button";

/** Lets the shell breadcrumb show the title of a nested page. */
const PageTitleContext = createContext<(title: string | null) => void>(
  () => {},
);
export function PageTitleProvider({
  children,
}: {
  children: (title: string | null) => ReactNode;
}) {
  const [title, setTitle] = useState<string | null>(null);
  return (
    <PageTitleContext.Provider value={setTitle}>
      {children(title)}
    </PageTitleContext.Provider>
  );
}

/**
 * The single page header. One title, an optional single-line description,
 * and at most one primary action plus secondary actions. List pages pass
 * their search and filters as `toolbar`, which shares the title row on wider
 * screens and drops to its own row on phones, below the title and actions.
 */
export function PageHeader({
  title,
  titleContent,
  count,
  description,
  media,
  meta,
  toolbar,
  actions,
  back,
}: {
  title: string;
  /** Shown in place of the title, e.g. an inline rename; `title` still
   * names the page. */
  titleContent?: ReactNode;
  /** Item count of a list page, shown muted beside the title. */
  count?: number;
  description?: ReactNode;
  media?: ReactNode;
  meta?: ReactNode;
  toolbar?: ReactNode;
  actions?: ReactNode;
  back?: { to: LinkProps["to"]; label: string; search?: LinkProps["search"] };
}) {
  const setTitle = useContext(PageTitleContext);
  useEffect(() => {
    setTitle(title);
    return () => setTitle(null);
  }, [setTitle, title]);
  return (
    <header className="flex flex-col gap-3">
      {back && (
        <Button
          variant="ghost"
          size="sm"
          asChild
          className="-ml-2 self-start md:hidden"
        >
          <Link to={back.to} search={back.search}>
            <ArrowLeft data-icon="inline-start" aria-hidden="true" />
            {back.label}
          </Link>
        </Button>
      )}
      <div
        data-toolbar={!!toolbar}
        className="flex min-h-8 flex-wrap items-start justify-between gap-x-6 gap-y-3 data-[toolbar=true]:items-center"
      >
        <div className="flex min-w-0 grow basis-48 items-center gap-3">
          {media}
          <div className="flex min-w-0 flex-col gap-0.5">
            <h1
              id="page-title"
              className="flex items-baseline gap-2 text-xl font-semibold tracking-tight text-balance"
            >
              {titleContent ?? title}
              {count !== undefined && (
                <span className="text-base font-normal text-muted-foreground tabular-nums">
                  {count}
                </span>
              )}
            </h1>
            {description && (
              <p className="truncate text-sm text-muted-foreground">
                {description}
              </p>
            )}
            {meta && (
              <div className="flex flex-wrap items-center gap-2 pt-1.5">
                {meta}
              </div>
            )}
          </div>
        </div>
        <HeaderControls toolbar={toolbar} actions={actions} />
      </div>
    </header>
  );
}

/**
 * Search/filters followed by actions, right-aligned beside a title. Below
 * `sm` the wrapper dissolves (`contents`) into the title row: actions stay
 * beside the title and the toolbar takes a full row underneath, where the
 * search field grows into the space the filters leave.
 */
function HeaderControls({
  toolbar,
  actions,
}: {
  toolbar?: ReactNode;
  actions?: ReactNode;
}) {
  if (!toolbar && !actions) return null;
  return (
    <div className="contents sm:flex sm:flex-wrap sm:items-center sm:justify-end sm:gap-2">
      {toolbar && (
        <div className="order-last flex w-full flex-wrap items-center gap-2 sm:order-none sm:w-auto sm:justify-end [&_[data-slot=input-group]]:min-w-40 [&_[data-slot=input-group]]:flex-1 sm:[&_[data-slot=input-group]]:w-64 sm:[&_[data-slot=input-group]]:flex-none">
          {toolbar}
        </div>
      )}
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </div>
  );
}

/** A titled region inside a page. Use instead of ad-hoc h2 + wrapper divs. */
export function Section({
  title,
  count,
  toolbar,
  actions,
  children,
  id,
}: {
  title: string;
  count?: number;
  toolbar?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-3">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-3">
        <h2 id={id} className="flex items-baseline gap-2 text-md font-semibold">
          {title}
          {count !== undefined && (
            <span className="text-sm font-normal text-muted-foreground tabular-nums">
              {count}
            </span>
          )}
        </h2>
        <HeaderControls toolbar={toolbar} actions={actions} />
      </div>
      {children}
    </section>
  );
}

/** Search + filters row above a list or table. */
export function Toolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 [&>*:first-child]:min-w-60 [&>*:first-child]:flex-1 sm:[&>*:first-child]:max-w-sm">
      {children}
    </div>
  );
}
