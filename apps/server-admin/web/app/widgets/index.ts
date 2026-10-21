import approvals from "./approvals";
import briefing from "./briefing";
import calendar from "./calendar";
import chart from "./chart";
import followups from "./followups";
import inbox from "./inbox";
import kpi from "./kpi";
import list from "./list";
import meetings from "./meetings";
import table from "./table";
import type { WidgetRenderer } from "./types";

export type {
  WidgetAsk,
  WidgetBodyProps,
  WidgetConfigProps,
  WidgetLanguage,
  WidgetRenderer,
} from "./types";

/**
 * The web renderers of the overview's widget types, by type. A new type is a
 * protocol module (packages/protocol/widgets) plus one renderer here.
 */
const RENDERERS = new Map<string, WidgetRenderer>(
  [
    calendar,
    inbox,
    briefing,
    kpi,
    chart,
    followups,
    list,
    table,
    approvals,
    meetings,
  ].map((renderer) => [renderer.type, renderer]),
);
export function widgetRenderer(type: string): WidgetRenderer | undefined {
  return RENDERERS.get(type);
}
