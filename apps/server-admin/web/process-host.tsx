import { createContext, useContext, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";

/**
 * Where the shared process designer and process page are mounted. The console
 * is the default; the web app provides its own value for personal processes.
 */
export type ProcessHost = {
  /**
   * How administration pages (limits, models, services) are reached: the
   * console's own router, a full page load from the web app (administrators),
   * or not at all (members, who ask an administrator instead).
   */
  adminLinks: "router" | "page" | "none";
  /** Only the signed-in person's own personal processes are managed here. */
  personalOnly?: boolean;
};
const consoleHost: ProcessHost = { adminLinks: "router" };
export const ProcessHostContext = createContext<ProcessHost>(consoleHost);
export const useProcessHost = () => useContext(ProcessHostContext);

/** A console path with its `$params` filled in, for a full page load. */
export function adminHref(to: string, params: Record<string, string> = {}) {
  return `/admin${to.replace(/\$(\w+)/g, (_, key: string) =>
    encodeURIComponent(params[key] ?? ""),
  )}`;
}

/** A link into administration, or plain text where the person can't go. */
export function AdminLink({
  to,
  params,
  className,
  plainClassName,
  children,
}: {
  to: string;
  params?: Record<string, string>;
  className?: string;
  /** Classes when shown as plain text; link hover styles don't apply there. */
  plainClassName?: string;
  children: ReactNode;
}) {
  const { adminLinks } = useProcessHost();
  if (adminLinks === "none")
    return <span className={plainClassName}>{children}</span>;
  if (adminLinks === "page")
    return (
      <a href={adminHref(to, params)} className={className}>
        {children}
      </a>
    );
  return (
    <Link to={to} params={params} className={className}>
      {children}
    </Link>
  );
}
