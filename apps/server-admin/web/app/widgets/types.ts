import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type { ClientSession } from "../../../../../packages/client-core/session";
import type { HubCard } from "../../../../../packages/protocol/hub";

export type WidgetLanguage = "en" | "cs";
/** Hands a prepared request to a new chat; nothing runs until it is sent. */
export type WidgetAsk = (text: string) => void;

export type WidgetBodyProps<D = unknown, C = Record<string, unknown>> = {
  data: D;
  config: C;
  /** The widget on the overview; null in the gallery's preview. */
  item: HubCard | null;
  language: WidgetLanguage;
  ask: WidgetAsk;
  /** The app's session (built-in widgets that read the app's own data). */
  session?: ClientSession;
  preview?: boolean;
  /** Opened large (a dialog over the overview): room for the full tool. */
  expanded?: boolean;
  /** Opens the widget large (the same dialog as the header's Expand). */
  onExpand?: () => void;
};
export type WidgetConfigProps<C = Record<string, unknown>> = {
  config: C;
  onChange: (config: C) => void;
  disabled: boolean;
  language: WidgetLanguage;
};

/**
 * The web half of a widget type (the protocol module is the other half):
 * its icon, how its data looks, its settings form and a few words that say
 * what it is set to ("today", "5 emails") for the chat handoff.
 */
export type WidgetRenderer<D = unknown, C = Record<string, unknown>> = {
  type: string;
  icon: LucideIcon;
  Body: ComponentType<WidgetBodyProps<D, C>>;
  Config?: ComponentType<WidgetConfigProps<C>>;
  describe?: (config: C, language: WidgetLanguage) => string;
  /** A tool that fills the large view's height (lists, grids, charts). */
  tall?: boolean;
};

/** Typed in the module, stored untyped in the registry. */
export const defineRenderer = <D, C>(renderer: WidgetRenderer<D, C>) =>
  renderer as unknown as WidgetRenderer;
