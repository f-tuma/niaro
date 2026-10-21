import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  Bot,
  Flag,
  LayoutGrid,
  Maximize,
  MousePointerClick,
  Plus,
  Redo2,
  Split,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { cn } from "cn";
import { Button } from "@admin/components/ui/button";
import { initials } from "@admin/components/console/entity-icon";
import type { DesignCapabilities } from "../../../packages/protocol/process-design";
import type { ProcessStep } from "../../../packages/protocol/service-processes";
import { UNCONNECTED, type Workflow } from "./lib/process-editor";
import type { EditorCopy } from "./process-editor-copy";
import {
  CANVAS_NODE_SIZE,
  canvasBounds,
  canvasConnectionProblem,
  canvasConnections,
  canvasEdgePath,
  canvasInput,
  canvasOutput,
  canvasPorts,
  canvasPortY,
  canvasWire,
  fitCanvas,
  layoutCanvas,
  placeCanvasSteps,
  snapToGrid,
  triggerPosition,
  zoomCanvas,
  type CanvasPoint,
  type CanvasPort,
  type CanvasViewport,
} from "./lib/process-canvas";

export type { CanvasPort } from "./lib/process-canvas";
export type ProcessEditorCanvasProps = {
  workflow: Workflow;
  capabilities: DesignCapabilities;
  selected: string;
  disabled: boolean;
  copy: EditorCopy;
  /** Where arranged positions are remembered in this browser. */
  layoutKey?: string;
  /** Problems with the graph that block saving, already phrased for people. */
  issues?: string[];
  canUndo?: boolean;
  canRedo?: boolean;
  onSelect(id: string): void;
  onConnect(from: string, to: string, port: CanvasPort): void;
  /** The manual start now leads to this step. */
  onEntry(to: string): void;
  onDisconnect(from: string, port: CanvasPort): void;
  /** Add a step after one output; `from: null` adds it before the entry.
   * `replace` attaches it to the output instead of inserting it into the
   * existing connection. */
  onAdd(
    from: string | null,
    port: CanvasPort,
    options?: { replace?: boolean },
  ): void;
  onDelete(id: string): void;
  onUndo?(): void;
  onRedo?(): void;
};
/** A connection starts at a step's output, or at the manual start (`null`). */
type Source = { from: string | null; port: CanvasPort };
type GestureKind =
  | { kind: "pan"; origin: CanvasPoint }
  | { kind: "node"; id: string; origin: CanvasPoint }
  | { kind: "wire"; source: Source };
type Gesture = {
  pointer: number;
  start: CanvasPoint;
  moved: boolean;
  capture: Element;
} & GestureKind;
type Wire = Source & { point: CanvasPoint; target?: string; refused?: boolean };
const LAYOUT_PREFIX = "niaro:process-canvas:";
/** A drag from an output ends with a click on it, which must not toggle it. */
const WIRE = "\u0000wire";
const icons = { agent: Bot, branch: Split, return: Flag };

function loadLayout(key?: string): Record<string, CanvasPoint> {
  if (!key) return {};
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(LAYOUT_PREFIX + key) ?? "{}",
    );
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        ([, point]) =>
          Number.isFinite((point as CanvasPoint)?.x) &&
          Number.isFinite((point as CanvasPoint)?.y),
      ),
    ) as Record<string, CanvasPoint>;
  } catch {
    return {};
  }
}
function saveLayout(key: string, positions: Record<string, CanvasPoint>) {
  try {
    localStorage.setItem(LAYOUT_PREFIX + key, JSON.stringify(positions));
  } catch {
    // Arrangement is a convenience; the process itself is unaffected.
  }
}
/** `search_people` reads as "Search people". */
export function readableName(name: string) {
  const words = name.replace(/[_-]+/g, " ").trim();
  return words === name ? name : words.charAt(0).toUpperCase() + words.slice(1);
}
function stepLabel(
  step: ProcessStep,
  capabilities: DesignCapabilities,
  copy: EditorCopy,
) {
  if (step.type === "action") {
    const service = capabilities.services.find(
      (item) => item.id === step.serviceId,
    );
    const action = service?.actions.find((item) => item.id === step.actionId);
    return {
      title: action ? readableName(action.name) : step.actionId,
      detail: service?.name ?? step.serviceId,
      mark: initials(service?.name ?? "?"),
      unavailable:
        !service?.enabled || !action?.enabled || action.status !== "configured",
    };
  }
  if (step.type === "agent") {
    const model = capabilities.models.find((item) => item.id === step.modelId);
    return {
      title: copy.agent,
      detail: model?.name ?? step.modelId,
      mark: "",
      unavailable: !model || model.status !== "configured" || !model.tools,
    };
  }
  return { title: copy[step.type], detail: "", mark: "", unavailable: false };
}
const portName = (port: CanvasPort, copy: EditorCopy) =>
  port === "whenTrue"
    ? copy.whenTrue
    : port === "whenFalse"
      ? copy.whenFalse
      : copy.next;

/** Geometry and navigation are local; only explicit callbacks change a definition. */
export function ProcessEditorCanvas({
  workflow,
  capabilities,
  selected,
  disabled,
  copy,
  layoutKey,
  issues = [],
  canUndo = false,
  canRedo = false,
  onSelect,
  onConnect,
  onEntry,
  onDisconnect,
  onAdd,
  onDelete,
  onUndo,
  onRedo,
}: ProcessEditorCanvasProps) {
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef<string | null>(null);
  const navigated = useRef(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [size, setSize] = useState({ width: 960, height: 560 });
  // Where a connection was dropped on empty canvas: the next new step goes there.
  const [dropHint, setDropHint] = useState<CanvasPoint>();
  const [stored, setStored] = useState(() =>
    placeCanvasSteps(workflow, loadLayout(layoutKey)),
  );
  const ids = workflow.steps.map((step) => step.id);
  const unplaced =
    ids.some((id) => !stored[id]) || Object.keys(stored).length !== ids.length;
  const positions = unplaced
    ? placeCanvasSteps(workflow, stored, dropHint)
    : stored;
  if (unplaced) {
    setStored(positions);
    if (dropHint) setDropHint(undefined);
  }
  const bounds = canvasBounds(positions, workflow.entry);
  const [view, setView] = useState<CanvasViewport>(() =>
    fitCanvas(bounds, size),
  );
  const [connection, setConnection] = useState<Source | null>(null);
  const [wire, setWire] = useState<Wire | null>(null);
  const [edge, setEdge] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const help = `canvas-help-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const connections = canvasConnections(workflow);
  const reachable = new Set<string>();
  for (const pending = [workflow.entry]; pending.length; ) {
    const id = pending.pop()!;
    if (reachable.has(id) || !ids.includes(id)) continue;
    reachable.add(id);
    pending.push(
      ...connections.filter((item) => item.from === id).map((item) => item.to),
    );
  }

  useEffect(() => {
    if (layoutKey && !unplaced) saveLayout(layoutKey, stored);
  }, [layoutKey, stored, unplaced]);
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => {
      const rectangle = element.getBoundingClientRect();
      if (rectangle.width > 0 && rectangle.height > 0)
        setSize({ width: rectangle.width, height: rectangle.height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const shape = ids.join("\n");
  useLayoutEffect(() => {
    if (navigated.current) return;
    // Every size, phones included, starts with the whole workflow in view;
    // zooming in is one tap away, a cut-off last step is easy to miss.
    setView(fitCanvas(bounds, size));
    // Only re-fit when the steps or the viewport change, not on every drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, workflow.entry, size]);
  useEffect(() => {
    const element = root.current;
    if (!element?.addEventListener) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      navigated.current = true;
      const box = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey)
        setView((current) =>
          zoomCanvas(current, Math.exp(-event.deltaY * 0.01), {
            x: event.clientX - box.left,
            y: event.clientY - box.top,
          }),
        );
      else
        setView((current) => ({
          ...current,
          x: current.x - event.deltaX,
          y: current.y - event.deltaY,
        }));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);
  if (
    (connection || wire) &&
    (disabled ||
      [connection?.from, wire?.from].some(
        (from) => from && !ids.includes(from),
      ))
  ) {
    setConnection(null);
    setWire(null);
    setProblem(null);
  }

  function zoom(factor: number) {
    navigated.current = true;
    setView((current) =>
      zoomCanvas(current, factor, { x: size.width / 2, y: size.height / 2 }),
    );
  }
  function fit() {
    navigated.current = true;
    setView(fitCanvas(bounds, size));
  }
  function cancel() {
    setConnection(null);
    setWire(null);
    setProblem(null);
  }
  function refusal(source: Source, to: string) {
    if (source.from === null) return null;
    const invalid = canvasConnectionProblem(
      workflow,
      source.from,
      to,
      source.port,
    );
    return invalid === "cycle" ? copy.cycle : invalid ? copy.dangling : null;
  }
  function connect(source: Source, to: string) {
    if (disabled) return;
    const refused = refusal(source, to);
    if (refused) {
      setProblem(refused);
      return;
    }
    if (source.from === null) {
      if (to !== workflow.entry) onEntry(to);
    } else {
      const step = workflow.steps.find((item) => item.id === source.from);
      if ((step as Record<string, unknown> | undefined)?.[source.port] !== to)
        onConnect(source.from, to, source.port);
    }
    cancel();
  }
  function revealNode(id: string) {
    const point = positions[id];
    if (!point) return;
    setView((current) => {
      const x = point.x * current.zoom + current.x;
      const y = point.y * current.zoom + current.y;
      if (
        current.zoom >= 0.75 &&
        x >= 16 &&
        y >= 16 &&
        x + CANVAS_NODE_SIZE * current.zoom <= size.width - 16 &&
        y + CANVAS_NODE_SIZE * current.zoom <= size.height - 64
      )
        return current;
      const zoom = Math.max(0.75, current.zoom);
      navigated.current = true;
      return {
        zoom,
        x: size.width / 2 - (point.x + CANVAS_NODE_SIZE / 2) * zoom,
        y: size.height / 2 - (point.y + CANVAS_NODE_SIZE / 2) * zoom,
      };
    });
  }
  function scenePoint(event: { clientX: number; clientY: number }) {
    const box = root.current?.getBoundingClientRect();
    return {
      x: (event.clientX - (box?.left ?? 0) - view.x) / view.zoom,
      y: (event.clientY - (box?.top ?? 0) - view.y) / view.zoom,
    };
  }
  function stepAt(point: CanvasPoint) {
    const reach = 20;
    return workflow.steps.find((step) => {
      const at = positions[step.id];
      return (
        at &&
        point.x >= at.x - reach &&
        point.x <= at.x + CANVAS_NODE_SIZE + reach &&
        point.y >= at.y - reach &&
        point.y <= at.y + CANVAS_NODE_SIZE + reach
      );
    })?.id;
  }
  function begin(event: React.PointerEvent, next: GestureKind) {
    if (event.button !== 0 || gesture.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    gesture.current = {
      ...next,
      pointer: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      moved: false,
      capture: event.currentTarget,
    } as Gesture;
  }
  function move(event: React.PointerEvent) {
    const drag = gesture.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    const dx = event.clientX - drag.start.x,
      dy = event.clientY - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) setEdge(null);
    drag.moved = true;
    if (drag.kind === "node") {
      navigated.current = true;
      setStored((current) => ({
        ...current,
        [drag.id]: {
          x: snapToGrid(drag.origin.x + dx / view.zoom),
          y: snapToGrid(drag.origin.y + dy / view.zoom),
        },
      }));
    } else if (drag.kind === "pan") {
      navigated.current = true;
      setView((current) => ({
        ...current,
        x: drag.origin.x + dx,
        y: drag.origin.y + dy,
      }));
    } else {
      const point = scenePoint(event);
      const target = stepAt(point);
      setProblem(null);
      setConnection(null);
      setWire({
        ...drag.source,
        point,
        target,
        refused: !!target && !!refusal(drag.source, target),
      });
    }
  }
  function finish(event: React.PointerEvent) {
    const drag = gesture.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    gesture.current = null;
    if (drag.capture.hasPointerCapture?.(event.pointerId))
      drag.capture.releasePointerCapture(event.pointerId);
    if (drag.kind === "node" && drag.moved) suppressClick.current = drag.id;
    if (drag.kind !== "wire" || !drag.moved) return;
    suppressClick.current = WIRE;
    const point = scenePoint(event);
    const target = stepAt(point);
    setWire(null);
    if (target) connect(drag.source, target);
    else if (drag.source.from !== null && !disabled) {
      // Dropped on empty canvas: choose the step to place there.
      setDropHint(point);
      onAdd(drag.source.from, drag.source.port, { replace: true });
    }
  }
  function hoverEdge(key: string | null) {
    clearTimeout(leaveTimer.current);
    if (key) setEdge(key);
    else leaveTimer.current = setTimeout(() => setEdge(null), 300);
  }
  const busy = !!wire || !!connection;
  const entryPosition = positions[workflow.entry];
  const trigger = entryPosition ? triggerPosition(entryPosition) : null;
  const triggerOut = trigger ? canvasOutput(trigger, "next") : null;
  const wireStart =
    wire &&
    (wire.from === null
      ? triggerOut
      : positions[wire.from]
        ? canvasOutput(positions[wire.from]!, wire.port)
        : null);
  const wireEnd =
    wire?.target && !wire.refused && positions[wire.target]
      ? canvasInput(positions[wire.target]!)
      : wire?.point;
  const edgeToolbar = (
    key: string,
    middle: CanvasPoint,
    add: () => void,
    remove?: () => void,
  ) => (
    <div
      key={`toolbar/${key}`}
      data-canvas-control
      data-shown={edge === key && !busy}
      className="pointer-events-auto absolute top-(--edge-y) left-(--edge-x) flex -translate-1/2 gap-1 opacity-0 transition-opacity focus-within:opacity-100 data-[shown=true]:opacity-100"
      style={
        {
          "--edge-x": `${middle.x}px`,
          "--edge-y": `${middle.y}px`,
        } as React.CSSProperties
      }
      onPointerEnter={() => hoverEdge(key)}
      onPointerLeave={() => hoverEdge(null)}
    >
      <Button
        variant="outline"
        size="icon-xs"
        disabled={disabled}
        aria-label={`${copy.addHere}: ${key}`}
        title={copy.addHere}
        onClick={() => {
          cancel();
          setEdge(null);
          add();
        }}
      >
        <Plus />
      </Button>
      {remove && (
        <Button
          variant="outline"
          size="icon-xs"
          disabled={disabled}
          aria-label={`${copy.deleteConnection}: ${key}`}
          title={copy.deleteConnection}
          onClick={() => {
            cancel();
            setEdge(null);
            remove();
          }}
        >
          <Trash2 />
        </Button>
      )}
    </div>
  );
  return (
    <div
      ref={root}
      role="region"
      aria-label={copy.graph}
      aria-describedby={help}
      tabIndex={0}
      data-testid="process-editor-canvas"
      data-process-canvas
      data-wiring={!!wire || undefined}
      className="relative h-(--canvas-height) min-h-96 w-full touch-none overflow-hidden bg-background bg-(image:--canvas-grid) bg-size-(--canvas-grid-size) bg-position-(--canvas-grid-position) outline-none select-none focus-visible:ring-2 focus-visible:ring-ring"
      style={
        {
          "--canvas-grid":
            "radial-gradient(circle, var(--border) 1px, transparent 1px)",
          "--canvas-grid-size": `${Math.max(8, 24 * view.zoom)}px ${Math.max(8, 24 * view.zoom)}px`,
          "--canvas-grid-position": `${view.x}px ${view.y}px`,
          "--canvas-height": "max(24rem, calc(100dvh - 20rem))",
        } as React.CSSProperties
      }
      onPointerDown={(event) => {
        const target = event.target as Element;
        if (target.closest?.("[data-canvas-control]")) return;
        // A tap on a connection shows its toolbar, as hovering does.
        const hit = target.getAttribute?.("data-edge-hit");
        if (hit) {
          hoverEdge(hit);
          return;
        }
        setEdge(null);
        begin(event, { kind: "pan", origin: view });
      }}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={(event) => {
        setWire(null);
        finish(event);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          cancel();
          return;
        }
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "z"
        ) {
          event.preventDefault();
          if (event.shiftKey) onRedo?.();
          else onUndo?.();
          return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key === "y") {
          event.preventDefault();
          onRedo?.();
          return;
        }
        if (event.target !== event.currentTarget) return;
        if (["+", "="].includes(event.key)) {
          event.preventDefault();
          zoom(1.2);
        } else if (event.key === "-") {
          event.preventDefault();
          zoom(1 / 1.2);
        } else if (event.key === "Home") {
          event.preventDefault();
          fit();
        } else if (
          ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
            event.key,
          )
        ) {
          event.preventDefault();
          navigated.current = true;
          setView((current) => ({
            ...current,
            x:
              current.x +
              (event.key === "ArrowLeft"
                ? 48
                : event.key === "ArrowRight"
                  ? -48
                  : 0),
            y:
              current.y +
              (event.key === "ArrowUp"
                ? 48
                : event.key === "ArrowDown"
                  ? -48
                  : 0),
          }));
        }
      }}
    >
      <p id={help} className="sr-only">
        {copy.panCanvas}
      </p>
      <div
        data-testid="canvas-scene"
        className="pointer-events-none absolute top-0 left-0 origin-top-left transform-(--canvas-transform)"
        style={
          {
            "--canvas-transform": `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
          } as React.CSSProperties
        }
      >
        <svg
          aria-hidden="true"
          width="1"
          height="1"
          className="pointer-events-none absolute top-0 left-0 overflow-visible text-muted-foreground"
        >
          {trigger && triggerOut && entryPosition && (
            <g data-edge="start">
              <path
                d={canvasWire(triggerOut, canvasInput(entryPosition)).path}
                fill="none"
                stroke={edge === "start" ? "var(--foreground)" : "currentColor"}
                strokeWidth="2"
              />
              <path
                d={canvasWire(triggerOut, canvasInput(entryPosition)).path}
                fill="none"
                stroke="transparent"
                strokeWidth="20"
                pointerEvents={busy ? "none" : "stroke"}
                data-edge-hit="start"
                onPointerEnter={() => hoverEdge("start")}
                onPointerLeave={() => hoverEdge(null)}
              />
            </g>
          )}
          {connections.map((item) => {
            const from = positions[item.from],
              to = positions[item.to];
            if (!from || !to) return null;
            const key = `${item.from}/${item.port}`;
            const active =
              (connection?.from === item.from &&
                connection.port === item.port) ||
              (wire?.from === item.from && wire.port === item.port);
            const { path } = canvasEdgePath(from, to, item.port);
            return (
              <g
                key={key}
                data-from={item.from}
                data-to={item.to}
                data-port={item.port}
              >
                <path
                  d={path}
                  fill="none"
                  stroke={
                    active
                      ? "var(--primary)"
                      : edge === key
                        ? "var(--foreground)"
                        : "currentColor"
                  }
                  strokeWidth="2"
                  strokeDasharray={wire && active ? "6 6" : undefined}
                />
                <path
                  d={path}
                  fill="none"
                  stroke="transparent"
                  strokeWidth="20"
                  pointerEvents={busy ? "none" : "stroke"}
                  data-edge-hit={key}
                  onPointerEnter={() => hoverEdge(key)}
                  onPointerLeave={() => hoverEdge(null)}
                />
              </g>
            );
          })}
          {wire && wireStart && wireEnd && (
            <path
              data-testid="canvas-wire"
              d={canvasWire(wireStart, wireEnd).path}
              fill="none"
              stroke={wire.refused ? "var(--destructive)" : "var(--primary)"}
              strokeWidth="2"
              strokeDasharray={wire.target ? undefined : "6 6"}
            />
          )}
        </svg>
        {trigger && (
          <div
            data-canvas-control
            className="pointer-events-auto absolute top-(--node-y) left-(--node-x) size-24"
            style={
              {
                "--node-x": `${trigger.x}px`,
                "--node-y": `${trigger.y}px`,
              } as React.CSSProperties
            }
          >
            <div
              role="img"
              aria-label={copy.manualTrigger}
              className="flex size-24 items-center justify-center rounded-l-4xl rounded-r-xl border-2 border-border bg-card text-muted-foreground"
            >
              <MousePointerClick className="size-8" />
            </div>
            <OutputHandle
              label={`${copy.connect}: ${copy.manualTrigger}`}
              port="next"
              active={connection?.from === null || wire?.from === null}
              disabled={disabled}
              onPointerDown={(event) =>
                begin(event, {
                  kind: "wire",
                  source: { from: null, port: "next" },
                })
              }
              onClick={() => {
                if (suppressClick.current === WIRE) {
                  suppressClick.current = null;
                  return;
                }
                setProblem(null);
                setConnection(
                  connection?.from === null
                    ? null
                    : { from: null, port: "next" },
                );
              }}
            />
            <div className="pointer-events-none absolute top-26 -left-10 flex w-44 flex-col items-center text-center">
              <span className="text-sm font-medium text-foreground">
                {copy.manualTrigger}
              </span>
            </div>
          </div>
        )}
        {workflow.steps.map((step) => {
          const point = positions[step.id]!,
            label = stepLabel(step, capabilities, copy),
            Icon = step.type === "action" ? null : icons[step.type];
          const target = wire?.target === step.id;
          return (
            <div
              key={step.id}
              data-canvas-control
              data-node-id={step.id}
              data-drop={target ? (wire.refused ? "refused" : "ok") : undefined}
              data-unreachable={!reachable.has(step.id) || undefined}
              className="group pointer-events-auto absolute top-(--node-y) left-(--node-x) size-24 data-unreachable:opacity-60"
              onFocus={() => revealNode(step.id)}
              style={
                {
                  "--node-x": `${point.x}px`,
                  "--node-y": `${point.y}px`,
                } as React.CSSProperties
              }
            >
              <button
                type="button"
                aria-label={`${copy.select}: ${step.id}`}
                aria-pressed={selected === step.id}
                disabled={disabled}
                title={`${label.title}${label.detail ? ` · ${label.detail}` : ""}${label.unavailable ? ` · ${copy.unavailable}` : ""}`}
                className={cn(
                  "flex size-24 cursor-grab items-center justify-center rounded-xl border-2 bg-card text-foreground shadow-xs outline-none transition-colors hover:border-ring focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-default",
                  selected === step.id
                    ? "border-primary ring-2 ring-primary/20"
                    : "border-border",
                  label.unavailable && "border-dashed text-muted-foreground",
                  target &&
                    (wire.refused ? "border-destructive" : "border-primary"),
                )}
                onPointerDown={(event) =>
                  begin(event, { kind: "node", id: step.id, origin: point })
                }
                onKeyDown={(event) => {
                  if (
                    !disabled &&
                    (event.key === "Delete" || event.key === "Backspace")
                  ) {
                    event.preventDefault();
                    onDelete(step.id);
                  }
                }}
                onClick={() => {
                  if (suppressClick.current === step.id) {
                    suppressClick.current = null;
                    return;
                  }
                  if (disabled) return;
                  if (connection) connect(connection, step.id);
                  else onSelect(step.id);
                }}
              >
                {Icon ? (
                  <Icon className="size-8" />
                ) : (
                  <span className="text-xl font-semibold">{label.mark}</span>
                )}
              </button>
              <div
                data-shown={selected === step.id && !busy}
                className="absolute -top-9 left-1/2 flex -translate-x-1/2 pb-3 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 data-[shown=true]:opacity-100"
              >
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={disabled}
                  aria-label={`${copy.remove}: ${step.id}`}
                  title={copy.remove}
                  onClick={() => onDelete(step.id)}
                >
                  <Trash2 />
                </Button>
              </div>
              <button
                type="button"
                aria-label={`${copy.connect}: ${step.id}`}
                disabled={
                  disabled || !connection || connection.from === step.id
                }
                title={`${copy.connect}: ${label.title}`}
                onClick={() => connection && connect(connection, step.id)}
                className="absolute top-9 -left-3.5 flex size-7 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
              >
                <span
                  className={cn(
                    "h-4 w-2 rounded-xs",
                    (connection && connection.from !== step.id) || target
                      ? "bg-primary"
                      : "bg-muted-foreground",
                  )}
                />
              </button>
              {canvasPorts(step).map((port) => {
                const open =
                  (step as Record<string, unknown>)[port] === UNCONNECTED;
                const name = portName(port, copy);
                const active =
                  (connection?.from === step.id && connection.port === port) ||
                  (wire?.from === step.id && wire.port === port);
                return (
                  <div key={port}>
                    {port !== "next" && (
                      <span
                        className="pointer-events-none absolute top-(--port-label-y) left-27 text-xs whitespace-nowrap text-muted-foreground"
                        style={
                          {
                            "--port-label-y": `${canvasPortY(port) - (port === "whenTrue" ? 22 : 2)}px`,
                          } as React.CSSProperties
                        }
                      >
                        {port === "whenTrue" ? copy.trueShort : copy.falseShort}
                      </span>
                    )}
                    <OutputHandle
                      label={`${copy.connect}: ${step.id} · ${name}`}
                      port={port}
                      active={active}
                      disabled={disabled}
                      onPointerDown={(event) =>
                        begin(event, {
                          kind: "wire",
                          source: { from: step.id, port },
                        })
                      }
                      onClick={() => {
                        if (suppressClick.current === WIRE) {
                          suppressClick.current = null;
                          return;
                        }
                        setProblem(null);
                        setConnection(active ? null : { from: step.id, port });
                      }}
                    />
                    {open && (
                      <div
                        className="absolute top-(--port-add-y) left-26 flex items-center"
                        style={
                          {
                            "--port-add-y": `${canvasPortY(port) - 12}px`,
                          } as React.CSSProperties
                        }
                      >
                        <span className="h-0.5 w-8 bg-border" />
                        <Button
                          variant="outline"
                          size="icon-xs"
                          disabled={disabled}
                          aria-label={`${copy.addAfter}: ${step.id} · ${name}`}
                          title={`${copy.addAfter}: ${name}`}
                          onClick={() => {
                            cancel();
                            onAdd(step.id, port);
                          }}
                        >
                          <Plus />
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="pointer-events-none absolute top-26 -left-10 flex w-44 flex-col items-center gap-0.5 text-center">
                <span className="line-clamp-2 max-w-full px-1 text-sm leading-tight font-medium text-foreground">
                  {label.title}
                </span>
                <span className="max-w-full truncate px-1 text-xs text-muted-foreground">
                  {label.detail || step.id}
                </span>
              </div>
            </div>
          );
        })}
        {trigger &&
          triggerOut &&
          entryPosition &&
          edgeToolbar(
            "start",
            canvasWire(triggerOut, canvasInput(entryPosition)).middle,
            () => onAdd(null, "next"),
          )}
        {connections.map((item) => {
          const from = positions[item.from],
            to = positions[item.to];
          if (!from || !to) return null;
          return edgeToolbar(
            `${item.from}/${item.port}`,
            canvasEdgePath(from, to, item.port).middle,
            () => onAdd(item.from, item.port),
            () => onDisconnect(item.from, item.port),
          );
        })}
      </div>
      {(connection || problem) && (
        <div
          data-canvas-control
          className="absolute top-3 right-3 left-3 flex max-w-lg items-center gap-2 rounded-md border border-border bg-background/95 px-3 py-2 text-xs shadow-xs"
          role="status"
          aria-live="polite"
        >
          <span className={cn("min-w-0 flex-1", problem && "text-destructive")}>
            {problem ??
              `${connection!.from ?? copy.manualTrigger} · ${portName(connection!.port, copy)}: ${copy.chooseTarget}`}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={copy.cancel}
            onClick={cancel}
          >
            <X />
          </Button>
        </div>
      )}
      {issues.length > 0 && !connection && !problem && (
        <ul
          data-canvas-control
          role="status"
          aria-live="polite"
          className="absolute top-3 right-3 left-3 flex flex-col gap-1 sm:left-auto sm:max-w-xs rounded-md border border-border bg-background/95 px-3 py-2 text-xs text-muted-foreground shadow-xs"
        >
          {issues.map((issue) => (
            <li key={issue} className="flex gap-2">
              <TriangleAlert
                aria-hidden="true"
                className="mt-px size-3.5 shrink-0 text-warning"
              />
              <span>{issue}</span>
            </li>
          ))}
        </ul>
      )}
      <div
        data-canvas-control
        className="absolute bottom-3 left-3 flex flex-wrap items-center gap-0.5 rounded-md border border-border bg-background p-1 shadow-xs"
        role="toolbar"
        aria-label={copy.graph}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={copy.zoomOut}
          title={copy.zoomOut}
          onClick={() => zoom(1 / 1.2)}
        >
          <ZoomOut />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={copy.resetZoom}
          title={copy.resetZoom}
          className="min-w-12"
          onClick={() => {
            navigated.current = true;
            setView((current) =>
              zoomCanvas(current, 1 / current.zoom, {
                x: size.width / 2,
                y: size.height / 2,
              }),
            );
          }}
        >
          {Math.round(view.zoom * 100)}%
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={copy.zoomIn}
          title={copy.zoomIn}
          onClick={() => zoom(1.2)}
        >
          <ZoomIn />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={copy.fitView}
          title={copy.fitView}
          onClick={fit}
        >
          <Maximize />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={copy.tidy}
          title={copy.tidy}
          onClick={() => {
            const next = layoutCanvas(workflow);
            setStored(next);
            navigated.current = true;
            setView(fitCanvas(canvasBounds(next, workflow.entry), size));
          }}
        >
          <LayoutGrid />
        </Button>
        {(onUndo || onRedo) && (
          <>
            <span className="mx-0.5 h-5 w-px bg-border" />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={copy.undo}
              title={`${copy.undo} (Ctrl+Z)`}
              disabled={disabled || !canUndo}
              onClick={onUndo}
            >
              <Undo2 />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={copy.redo}
              title={`${copy.redo} (Ctrl+Shift+Z)`}
              disabled={disabled || !canRedo}
              onClick={onRedo}
            >
              <Redo2 />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function OutputHandle({
  label,
  port,
  active,
  disabled,
  onPointerDown,
  onClick,
}: {
  label: string;
  port: CanvasPort;
  active: boolean;
  disabled: boolean;
  onPointerDown(event: React.PointerEvent): void;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      title={label}
      className="absolute top-(--port-y) left-20.5 flex size-7 cursor-crosshair items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50"
      style={
        { "--port-y": `${canvasPortY(port) - 14}px` } as React.CSSProperties
      }
      onPointerDown={(event) => {
        if (!disabled) onPointerDown(event);
      }}
      onClick={onClick}
    >
      <span
        className={cn(
          "size-3.5 rounded-full border-2 bg-background transition-colors",
          active ? "border-primary bg-primary" : "border-muted-foreground",
        )}
      />
    </button>
  );
}
