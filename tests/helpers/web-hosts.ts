import React from "react";

/**
 * A stand-in for a design-system module (`@admin/components/...`): every
 * export is a plain DOM host carrying its props, so tests drive the page's
 * real handlers without the widgets' browser behaviour. `asChild` renders
 * the child itself, as Radix slots do.
 */
const element = (name: string) =>
  /Textarea$/.test(name)
    ? "textarea"
    : /(Button|Trigger)$/.test(name) || name === "SidebarMenuAction"
      ? "button"
      : name === "Input"
        ? "input"
        : "div";
const hosts = new Map<string, React.ComponentType<Record<string, unknown>>>();
function host(name: string) {
  let component = hosts.get(name);
  if (!component) {
    component = Object.assign(
      ({
        asChild,
        children,
        ...props
      }: Record<string, unknown> & { children?: React.ReactNode }) =>
        asChild
          ? (children as React.ReactElement)
          : React.createElement(
              element(name),
              { ...props, "data-host": name },
              children,
            ),
      { displayName: name },
    );
    hosts.set(name, component);
  }
  return component;
}
export function hostModule(overrides: Record<string, unknown> = {}) {
  return new Proxy(overrides, {
    get(target, name) {
      if (typeof name !== "string") return undefined;
      if (name in target) return target[name];
      if (name === "__esModule") return true;
      if (name === "then" || name === "default") return undefined;
      return host(name);
    },
  });
}
