import {
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { ArrowDown, ArrowUp, GripVertical, MoveDiagonal2 } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { HUB_COLUMNS, type HubLayout } from "../../../../packages/protocol/hub";
import {
  hubDragLayout,
  hubFitLayout,
  hubMove,
  hubOverlaps,
  hubReadingOrder,
  type HubPlaced,
  type HubSizeKey,
} from "../../../../packages/protocol/hub-dashboard";
import type { HubCopy } from "./hub-copy";

export type HubGridItem = {
  id: string;
  layout: HubLayout;
  /** The item's size rules: its view type or its widget type's size. */
  size: HubSizeKey;
};
/** What a widget shows in its header while the grid is being edited. */
export type HubGridControls = { move: ReactNode; resize: ReactNode };

type Drag = {
  id: string;
  mode: "move" | "resize";
  start: { x: number; y: number };
  origin: HubLayout;
  base: HubPlaced[];
  cell: { width: number; height: number };
  next: HubPlaced[] | null;
};
const KEYS: Record<string, { x: number; y: number }> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/** One grid cell's size including the gap, measured from the grid itself. */
function cellOf(grid: HTMLElement | null) {
  if (!grid || typeof getComputedStyle === "undefined")
    return { width: 80, height: 96 };
  const style = getComputedStyle(grid);
  const gap = parseFloat(style.columnGap) || 0;
  const rowGap = parseFloat(style.rowGap) || 0;
  const width = grid.getBoundingClientRect().width;
  return {
    width: (width - gap * 11) / 12 + gap,
    height: (parseFloat(style.gridAutoRows) || 80) + rowGap,
  };
}

/**
 * The dashboard grid: twelve columns from `md` up, one column (in reading
 * order) below it. While editing, a widget moves by its grip and resizes by
 * its corner (pointer or arrow keys); others make room and float up. Phones
 * only reorder, with up and down.
 */
export function HubGrid({
  items,
  editing,
  disabled,
  copy,
  onLayout,
  onReorder,
  render,
}: {
  items: HubGridItem[];
  editing: boolean;
  disabled: boolean;
  copy: HubCopy;
  /** The whole grid after a move or resize. */
  onLayout: (next: HubPlaced[]) => void;
  /** Phones: the new reading order. */
  onReorder: (ids: string[]) => void;
  render: (id: string, controls: HubGridControls | null) => ReactNode;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [preview, setPreview] = useState<{
    id: string;
    items: HubPlaced[];
  } | null>(null);
  const ordered = hubReadingOrder(items);
  const placed = new Map(
    (preview?.items ?? items).map((item) => [item.id, item.layout]),
  );
  const typeOf = (id: string): HubSizeKey =>
    items.find((item) => item.id === id)?.size ?? "summary";
  /** The control with keyboard focus shows its widget's place as a ghost. */
  const [focused, setFocused] = useState<string | null>(null);
  const current = (): HubPlaced[] =>
    items.map((item) => ({ id: item.id, layout: item.layout }));
  const commit = (next: HubPlaced[]) => {
    const before = new Map(items.map((item) => [item.id, item.layout]));
    if (
      next.some(
        (item) =>
          JSON.stringify(item.layout) !== JSON.stringify(before.get(item.id)),
      )
    )
      onLayout(next);
  };

  const begin = (
    event: PointerEvent<HTMLElement>,
    id: string,
    mode: Drag["mode"],
  ) => {
    if (!editing || disabled || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const origin = items.find((item) => item.id === id)!.layout;
    drag.current = {
      id,
      mode,
      start: { x: event.clientX, y: event.clientY },
      origin,
      base: current(),
      cell: cellOf(grid.current),
      next: null,
    };
  };
  const follow = (event: PointerEvent<HTMLElement>) => {
    const active = drag.current;
    if (!active) return;
    const layout = hubDragLayout(
      active.origin,
      active.mode,
      { x: event.clientX - active.start.x, y: event.clientY - active.start.y },
      active.cell,
      typeOf(active.id),
    );
    active.next = hubMove(active.base, active.id, layout);
    setPreview({ id: active.id, items: active.next });
  };
  const end = () => {
    const active = drag.current;
    drag.current = null;
    setPreview(null);
    if (active?.next) commit(active.next);
  };
  /** The browser took the pointer (a scroll, a system gesture): put it back. */
  const cancel = () => {
    drag.current = null;
    setPreview(null);
  };
  const nudge = (
    event: KeyboardEvent<HTMLElement>,
    id: string,
    mode: Drag["mode"],
  ) => {
    const step = KEYS[event.key];
    if (!step || disabled) return;
    event.preventDefault();
    const origin = items.find((item) => item.id === id)!.layout;
    const layout = hubFitLayout(
      mode === "move"
        ? { ...origin, x: origin.x + step.x, y: origin.y + step.y }
        : { ...origin, w: origin.w + step.x, h: origin.h + step.y },
      typeOf(id),
    );
    commit(hubMove(current(), id, layout));
  };
  const reorder = (index: number, by: -1 | 1) => {
    const ids = ordered.map((item) => item.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + by, 0, moved!);
    onReorder(ids);
  };

  const shown = preview?.items ?? current();
  const ghostId = preview?.id ?? (editing ? focused : null);
  const ghost = ghostId
    ? shown.find((item) => item.id === ghostId)?.layout
    : undefined;
  // Every occupied row and one free row below, as the cells a widget can take.
  const rows = editing
    ? Math.max(0, ...shown.map((item) => item.layout.y + item.layout.h)) + 1
    : 0;
  const slots: { x: number; y: number; free: boolean }[] = [];
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < HUB_COLUMNS; x++)
      slots.push({
        x,
        y,
        free: !shown.some((item) =>
          hubOverlaps(item.layout, { x, y, w: 1, h: 1 }),
        ),
      });
  const keyboard = (id: string) => ({
    onFocus: () => setFocused(id),
    onBlur: () => setFocused((value) => (value === id ? null : value)),
  });

  return (
    <div
      ref={grid}
      data-testid="hub-grid"
      data-editing={editing}
      className="grid grid-cols-1 gap-4 md:auto-rows-(--hub-row) md:grid-cols-12"
      style={{ "--hub-row": "4.5rem" } as React.CSSProperties}
    >
      {slots.map((slot) => (
        <div
          key={`${slot.x},${slot.y}`}
          aria-hidden="true"
          data-testid="hub-slot"
          data-x={slot.x}
          data-y={slot.y}
          data-free={slot.free}
          className="pointer-events-none hidden rounded-md border border-dashed border-border data-[free=false]:border-transparent data-[free=false]:bg-muted md:col-(--hub-col) md:row-(--hub-rows) md:block"
          style={
            {
              "--hub-col": `${slot.x + 1} / span ${1}`,
              "--hub-rows": `${slot.y + 1} / span ${1}`,
            } as React.CSSProperties
          }
        />
      ))}
      {ghost && (
        <div
          aria-hidden="true"
          data-testid="hub-ghost"
          data-layout={`${ghost.x},${ghost.y},${ghost.w},${ghost.h}`}
          className="pointer-events-none z-20 hidden rounded-xl border-2 border-dashed border-primary bg-primary/5 md:col-(--hub-col) md:row-(--hub-rows) md:block"
          style={
            {
              "--hub-col": `${ghost.x + 1} / span ${ghost.w}`,
              "--hub-rows": `${ghost.y + 1} / span ${ghost.h}`,
            } as React.CSSProperties
          }
        />
      )}
      {ordered.map((item, index) => {
        const layout = placed.get(item.id) ?? item.layout;
        const controls: HubGridControls | null = editing
          ? {
              move: (
                <>
                  <span className="hidden md:contents">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={copy.move}
                      disabled={disabled}
                      data-testid="hub-move"
                      className="touch-none"
                      onPointerDown={(event) => begin(event, item.id, "move")}
                      onPointerMove={follow}
                      onPointerUp={end}
                      onPointerCancel={cancel}
                      onKeyDown={(event) => nudge(event, item.id, "move")}
                      {...keyboard(item.id)}
                    >
                      <GripVertical aria-hidden="true" />
                    </Button>
                  </span>
                  <span className="contents md:hidden">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={copy.moveUp}
                      disabled={disabled || index === 0}
                      onClick={() => reorder(index, -1)}
                    >
                      <ArrowUp aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={copy.moveDown}
                      disabled={disabled || index === ordered.length - 1}
                      onClick={() => reorder(index, 1)}
                    >
                      <ArrowDown aria-hidden="true" />
                    </Button>
                  </span>
                </>
              ),
              resize: (
                <button
                  type="button"
                  aria-label={copy.resize}
                  disabled={disabled}
                  data-testid="hub-resize"
                  className="absolute right-1 bottom-1 hidden size-6 cursor-se-resize touch-none items-center justify-center rounded-sm text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50 md:flex"
                  onPointerDown={(event) => begin(event, item.id, "resize")}
                  onPointerMove={follow}
                  onPointerUp={end}
                  onPointerCancel={cancel}
                  onKeyDown={(event) => nudge(event, item.id, "resize")}
                  {...keyboard(item.id)}
                >
                  <MoveDiagonal2 aria-hidden="true" />
                </button>
              ),
            }
          : null;
        return (
          <div
            key={item.id}
            data-testid="hub-cell"
            data-id={item.id}
            data-layout={`${layout.x},${layout.y},${layout.w},${layout.h}`}
            data-active={preview?.id === item.id}
            className="relative flex min-w-0 flex-col data-[active=true]:z-10 data-[active=true]:opacity-90 md:col-(--hub-col) md:row-(--hub-rows)"
            style={
              {
                "--hub-col": `${layout.x + 1} / span ${layout.w}`,
                "--hub-rows": `${layout.y + 1} / span ${layout.h}`,
              } as React.CSSProperties
            }
          >
            {render(item.id, controls)}
            {controls?.resize}
          </div>
        );
      })}
    </div>
  );
}
