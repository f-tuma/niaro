import type { LinkProps } from "@tanstack/react-router";
import {
  Boxes,
  Cable,
  Cpu,
  Gauge,
  GitBranch,
  History,
  LayoutDashboard,
  PlugZap,
  Puzzle,
  ScrollText,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";

export type NavKey =
  | "overview"
  | "processes"
  | "skills"
  | "services"
  | "plugins"
  | "routing"
  | "usage"
  | "mcp"
  | "providers"
  | "people"
  | "workspaces"
  | "signIn"
  | "hosted"
  | "audit"
  | "loops"
  | "settings";
export type NavItem = {
  to: NonNullable<LinkProps["to"]>;
  key: NavKey;
  icon: LucideIcon;
};
export type NavGroup = {
  label?:
    | "groupServices"
    | "groupAi"
    | "groupProcesses"
    | "groupPeople"
    | "groupSettings";
  items: NavItem[];
};

/** The admin sidebar: what connects to services, then AI, processes, people, settings. */
export const navigation: NavGroup[] = [
  { items: [{ to: "/", key: "overview", icon: LayoutDashboard }] },
  {
    label: "groupServices",
    items: [
      { to: "/services", key: "services", icon: Cable },
      { to: "/hosted", key: "hosted", icon: Server },
      { to: "/plugins", key: "plugins", icon: Puzzle },
      { to: "/mcp", key: "mcp", icon: PlugZap },
    ],
  },
  {
    label: "groupAi",
    items: [
      { to: "/providers", key: "providers", icon: Cpu },
      { to: "/routing", key: "routing", icon: GitBranch },
      { to: "/usage", key: "usage", icon: Gauge },
      { to: "/skills", key: "skills", icon: Sparkles },
    ],
  },
  {
    label: "groupProcesses",
    items: [
      { to: "/processes", key: "processes", icon: Workflow },
      { to: "/loops", key: "loops", icon: History },
    ],
  },
  {
    label: "groupPeople",
    items: [
      { to: "/people", key: "people", icon: Users },
      { to: "/workspaces", key: "workspaces", icon: Boxes },
      { to: "/auth-providers", key: "signIn", icon: ShieldCheck },
    ],
  },
  {
    label: "groupSettings",
    items: [
      { to: "/audit", key: "audit", icon: ScrollText },
      { to: "/settings", key: "settings", icon: Settings2 },
    ],
  },
];
