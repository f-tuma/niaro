import {
  HUB_COLUMNS,
  HUB_MAX_HEIGHT,
  HUB_MAX_ROW,
  type HubField,
  type HubLayout,
  type HubWidgetType,
  type HubWidgetView,
} from "./hub";
import { hubWidgetDefinition, type HubWidgetSize } from "./widgets";

/**
 * The dashboard's shared rules, used by the server (to check what it stores)
 * and by the web app (to offer only what fits): widget sizes, placing and
 * moving widgets on the grid, and which views a process output allows.
 */
export const HUB_WIDGET_SIZES: Record<
  HubWidgetType,
  { w: number; h: number; minW: number; minH: number }
> = {
  tasks: { w: 4, h: 3, minW: 3, minH: 2 },
  summary: { w: 6, h: 4, minW: 3, minH: 2 },
  number: { w: 3, h: 2, minW: 2, minH: 2 },
  list: { w: 4, h: 4, minW: 3, minH: 2 },
  table: { w: 6, h: 4, minW: 4, minH: 3 },
  chart: { w: 6, h: 4, minW: 3, minH: 3 },
  text: { w: 6, h: 3, minW: 3, minH: 2 },
  /** A typed widget whose type this build doesn't know (agent-hub/3). */
  widget: { w: 4, h: 3, minW: 2, minH: 2 },
};
/** A view type, or a typed widget's own size from the registry. */
export type HubSizeKey = HubWidgetType | HubWidgetSize;
export const hubSize = (key: HubSizeKey): HubWidgetSize =>
  typeof key === "string" ? HUB_WIDGET_SIZES[key] : key;
/** The size rules of one item: its view's, or its widget type's. */
export function hubItemSize(item: {
  view: { type: HubWidgetType };
  widget?: { type: string } | null;
}): HubWidgetSize {
  if (item.widget)
    return (
      hubWidgetDefinition(item.widget.type)?.size ?? HUB_WIDGET_SIZES.widget
    );
  return HUB_WIDGET_SIZES[item.view.type];
}

export type HubPlaced = { id: string; layout: HubLayout };

export const hubOverlaps = (a: HubLayout, b: HubLayout) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The layout kept inside the grid and at least the view's minimum size. */
export function hubFitLayout(layout: HubLayout, type: HubSizeKey) {
  const size = hubSize(type);
  const w = Math.min(HUB_COLUMNS, Math.max(size.minW, Math.round(layout.w)));
  const h = Math.min(HUB_MAX_HEIGHT, Math.max(size.minH, Math.round(layout.h)));
  return {
    x: Math.min(HUB_COLUMNS - w, Math.max(0, Math.round(layout.x))),
    y: Math.min(HUB_MAX_ROW, Math.max(0, Math.round(layout.y))),
    w,
    h,
  };
}

/** The first free place from the top left that fits the size. */
export function hubPlace(
  taken: HubLayout[],
  size: { w: number; h: number },
  /** Only places after this one in reading order. */
  after?: { x: number; y: number },
): HubLayout {
  const w = Math.min(HUB_COLUMNS, size.w);
  for (let y = after?.y ?? 0; y <= HUB_MAX_ROW; y++)
    for (let x = 0; x + w <= HUB_COLUMNS; x++) {
      if (after && y === after.y && x <= after.x) continue;
      const candidate = { x, y, w, h: size.h };
      if (!taken.some((other) => hubOverlaps(candidate, other)))
        return candidate;
    }
  return { x: 0, y: HUB_MAX_ROW, w, h: size.h };
}

/** Top to bottom, then left to right: the order on a phone. */
export const hubReadingOrder = <T extends { layout: HubLayout }>(items: T[]) =>
  [...items].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);

/**
 * Floats every widget up as far as it goes, in reading order; `first` wins
 * ties so a moved widget keeps the place it was dropped on.
 */
export function hubCompact(items: HubPlaced[], first?: string): HubPlaced[] {
  const order = [...items].sort(
    (a, b) =>
      a.layout.y - b.layout.y ||
      (a.id === first ? -1 : b.id === first ? 1 : 0) ||
      a.layout.x - b.layout.x,
  );
  const placed: HubPlaced[] = [];
  for (const item of order) {
    const layout = { ...item.layout };
    const collides = () =>
      placed.some((other) => hubOverlaps(layout, other.layout));
    while (collides()) layout.y++;
    while (layout.y > 0) {
      layout.y--;
      if (collides()) {
        layout.y++;
        break;
      }
    }
    placed.push({ id: item.id, layout });
  }
  const at = new Map(placed.map((item) => [item.id, item.layout]));
  return items.map((item) => ({ id: item.id, layout: at.get(item.id)! }));
}

/**
 * Puts one widget at a new place or size; widgets in the way move down,
 * then everything floats up. The result never overlaps.
 */
export function hubMove(
  items: HubPlaced[],
  id: string,
  next: HubLayout,
): HubPlaced[] {
  const moved = items.map((item) =>
    item.id === id ? { id, layout: { ...next } } : item,
  );
  const target = moved.find((item) => item.id === id);
  if (!target) return items;
  const settled: HubPlaced[] = [target];
  const others = moved
    .filter((item) => item.id !== id)
    .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
  for (const item of others) {
    const layout = { ...item.layout };
    for (;;) {
      const hit = settled.find((other) => hubOverlaps(layout, other.layout));
      if (!hit) break;
      layout.y = hit.layout.y + hit.layout.h;
    }
    settled.push({ id: item.id, layout });
  }
  const at = new Map(settled.map((item) => [item.id, item.layout]));
  return hubCompact(
    moved.map((item) => ({ id: item.id, layout: at.get(item.id)! })),
    id,
  );
}

/** Widgets in this reading order, each at the first free place after the
 * one before it (reorder, migration). */
export function hubPack(
  order: { id: string; w: number; h: number }[],
): HubPlaced[] {
  const placed: HubPlaced[] = [];
  for (const item of order)
    placed.push({
      id: item.id,
      layout: hubPlace(
        placed.map((other) => other.layout),
        item,
        placed.at(-1)?.layout,
      ),
    });
  return placed;
}

/** Why a whole grid cannot be stored, or null. */
export function hubLayoutIssue(
  items: { layout: HubLayout; type: HubSizeKey }[],
) {
  for (const [index, item] of items.entries()) {
    const size = hubSize(item.type);
    if (
      item.layout.w < size.minW ||
      item.layout.h < size.minH ||
      item.layout.x + item.layout.w > HUB_COLUMNS
    )
      return "hub_layout_invalid";
    if (
      items
        .slice(index + 1)
        .some((other) => hubOverlaps(item.layout, other.layout))
    )
      return "hub_layout_invalid";
  }
  return null;
}

const TEXT_KEYS = [
  "markdown",
  "summary",
  "text",
  "report",
  "message",
  "content",
  "shrnuti",
  "souhrn",
  "zprava",
];
const LABEL_KEYS = ["label", "name", "title", "stage", "category", "nazev"];
const VALUE_KEYS = ["value", "count", "amount", "total", "pocet", "castka"];
const prefer = <T extends { key: string }>(list: T[], keys: string[]) =>
  list.find((item) => keys.includes(item.key.toLowerCase())) ?? list[0];

/**
 * The view with its defaults filled in (chart axes, list title), or why it
 * does not fit the output. `fields` null means the output is not known now:
 * only views that need no field fit then.
 */
export function hubResolveView(
  view: HubWidgetView,
  kind: "tasks" | "process",
  fields: HubField[] | null,
): { view: HubWidgetView } | { error: string } {
  const invalid = { error: "hub_view_invalid" };
  if (kind === "tasks") return view.type === "tasks" ? { view } : invalid;
  if (view.type === "tasks" || view.type === "widget") return invalid;
  if (view.type === "summary") return { view };
  if (!fields) return { error: "hub_view_unavailable" };
  const field = fields.find((value) => value.key === view.field);
  if (!field) return invalid;
  const inner = field.fields ?? [];
  const has = (key: string | undefined, types?: string[]) =>
    !key ||
    inner.some(
      (value) => value.key === key && (!types || types.includes(value.type)),
    );
  switch (view.type) {
    case "number": {
      if (field.type !== "number") return invalid;
      const compare = view.compare;
      if (compare && compare !== "previous") {
        const other = fields.find((value) => value.key === compare.field);
        if (!other || other.type !== "number" || other.key === field.key)
          return invalid;
      }
      return { view };
    }
    case "text":
      return field.type === "string" ? { view } : invalid;
    case "list": {
      if (field.type !== "array") return invalid;
      if (field.items) return view.title || view.subtitle ? invalid : { view };
      if (!inner.length || !has(view.title) || !has(view.subtitle))
        return invalid;
      const title =
        view.title ??
        prefer(
          inner.filter((value) => value.type === "string"),
          LABEL_KEYS,
        )?.key ??
        inner[0]!.key;
      return { view: { ...view, title } };
    }
    case "table": {
      if (field.type !== "array" || !inner.length) return invalid;
      const keys = view.columns.map((column) => column.key);
      if (new Set(keys).size !== keys.length || keys.some((key) => !has(key)))
        return invalid;
      return { view };
    }
    case "chart": {
      if (field.type !== "array" || !inner.length) return invalid;
      if (!has(view.x, ["string", "number"]) || !has(view.y, ["number"]))
        return invalid;
      const x =
        view.x ??
        prefer(
          inner.filter((value) => value.type === "string"),
          LABEL_KEYS,
        )?.key ??
        inner.find((value) => value.type === "number")?.key;
      const y =
        view.y ??
        prefer(
          inner.filter((value) => value.type === "number" && value.key !== x),
          VALUE_KEYS,
        )?.key;
      if (!x || !y || x === y) return invalid;
      return { view: { ...view, x, y } };
    }
  }
}

/** The first view of this type that fits the output, or null. */
export function hubViewFor(
  type: HubWidgetType,
  fields: HubField[] | null,
): HubWidgetView | null {
  if (type === "summary") return { type };
  if (type === "tasks" || type === "widget" || !fields) return null;
  const candidates: HubWidgetView[] = [];
  switch (type) {
    case "number":
      for (const field of fields)
        if (field.type === "number")
          candidates.push({ type, field: field.key });
      break;
    case "text": {
      const strings = fields.filter((field) => field.type === "string");
      const text = prefer(strings, TEXT_KEYS);
      if (text) candidates.push({ type, field: text.key });
      break;
    }
    case "list":
      for (const field of fields)
        if (field.type === "array") {
          const strings = (field.fields ?? []).filter(
            (value) => value.type === "string",
          );
          const title = prefer(strings, LABEL_KEYS)?.key;
          const subtitle = (field.fields ?? []).find(
            (value) => value.key !== title,
          )?.key;
          candidates.push(
            field.items
              ? { type, field: field.key }
              : {
                  type,
                  field: field.key,
                  ...(title ? { title } : {}),
                  ...(subtitle ? { subtitle } : {}),
                },
          );
        }
      break;
    case "table":
      for (const field of fields)
        if (field.type === "array" && field.fields?.length)
          candidates.push({
            type,
            field: field.key,
            columns: field.fields.slice(0, 4).map((value) => ({
              key: value.key,
            })),
          });
      break;
    case "chart":
      for (const field of fields)
        if (field.type === "array")
          candidates.push({ type, chart: "bar", field: field.key });
      break;
  }
  for (const candidate of candidates) {
    const resolved = hubResolveView(candidate, "process", fields);
    if ("view" in resolved) return resolved.view;
  }
  return null;
}

/** The view types this output allows, in the order the picker offers them. */
export function hubViewChoices(
  kind: "tasks" | "process",
  fields: HubField[] | null,
): HubWidgetType[] {
  if (kind === "tasks") return ["tasks"];
  return (
    ["number", "chart", "list", "table", "text", "summary"] as const
  ).filter((type) => !!hubViewFor(type, fields));
}

/**
 * A sensible first view: a lone number as a number, a lone text as text, a
 * lone array as a chart (label and value), table (many columns) or list;
 * anything richer keeps the summary that shows every field.
 */
export function hubDefaultView(
  kind: "tasks" | "process",
  fields: HubField[] | null,
): HubWidgetView {
  if (kind === "tasks") return { type: "tasks" };
  if (!fields?.length) return { type: "summary" };
  const numbers = fields.filter((field) => field.type === "number");
  const arrays = fields.filter((field) => field.type === "array");
  const strings = fields.filter((field) => field.type === "string");
  if (fields.length === 1) {
    const field = fields[0]!;
    if (field.type === "number") return hubViewFor("number", fields)!;
    if (field.type === "string") return hubViewFor("text", fields)!;
    if (field.type === "array") {
      const inner = field.fields ?? [];
      const scalars = inner.length;
      const chart = hubViewFor("chart", fields);
      if (chart && scalars <= 3) return chart;
      if (scalars >= 3)
        return hubViewFor("table", fields) ?? { type: "summary" };
      return hubViewFor("list", fields) ?? { type: "summary" };
    }
  }
  if (numbers.length === 1 && !arrays.length && !strings.length)
    return { type: "number", field: numbers[0]!.key };
  return { type: "summary" };
}

/**
 * Where a drag ends on the grid: the start place moved (or resized) by the
 * pointer's travel in whole cells, kept inside the grid and the view's limits.
 */
export function hubDragLayout(
  origin: HubLayout,
  mode: "move" | "resize",
  travel: { x: number; y: number },
  cell: { width: number; height: number },
  type: HubSizeKey,
): HubLayout {
  const dx = Math.round(travel.x / Math.max(1, cell.width));
  const dy = Math.round(travel.y / Math.max(1, cell.height));
  return hubFitLayout(
    mode === "move"
      ? { ...origin, x: origin.x + dx, y: origin.y + dy }
      : { ...origin, w: origin.w + dx, h: origin.h + dy },
    type,
  );
}
