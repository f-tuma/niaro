import { UNCONNECTED, type Workflow } from "./process-editor";

export type CanvasPort = "next" | "whenTrue" | "whenFalse";
export type CanvasPoint = { x: number; y: number };
export type CanvasViewport = CanvasPoint & { zoom: number };
export type CanvasBounds = CanvasPoint & { width: number; height: number };
export type CanvasConnection = { from: string; to: string; port: CanvasPort };
/** A position is the top-left corner of a step's square. */
export const CANVAS_GRID = 24;
export const CANVAS_NODE_SIZE = 96;
/** The label beneath a step is wider than its square and centred on it. */
export const CANVAS_LABEL_WIDTH = 176;
export const CANVAS_LABEL_HEIGHT = 48;
export const CANVAS_COLUMN = 240;
export const CANVAS_ROW = 168;
export const CANVAS_MIN_ZOOM = 0.1;
export const CANVAS_MAX_ZOOM = 2;
const ORIGIN = { x: 264, y: 72 };

export function canvasConnections(workflow: Workflow): CanvasConnection[] {
  return workflow.steps.flatMap((step): CanvasConnection[] => {
    if (step.type === "return") return [];
    const ports: CanvasPort[] =
      step.type === "branch" ? ["whenTrue", "whenFalse"] : ["next"];
    return ports
      .map((port) => ({
        from: step.id,
        to: (step as unknown as Record<CanvasPort, string>)[port],
        port,
      }))
      .filter((edge) => edge.to !== UNCONNECTED);
  });
}
export function canvasPorts(step: Workflow["steps"][number]): CanvasPort[] {
  return step.type === "return"
    ? []
    : step.type === "branch"
      ? ["whenTrue", "whenFalse"]
      : ["next"];
}
export const snapToGrid = (value: number) =>
  Math.round(value / CANVAS_GRID) * CANVAS_GRID;
/** The manual start sits one column before the entry step. */
export const triggerPosition = (entry: CanvasPoint): CanvasPoint => ({
  x: entry.x - CANVAS_COLUMN,
  y: entry.y,
});

/** Left-to-right layers by longest path from the start; a condition's second
 * exit opens a new row so both paths stay readable. */
export function layoutCanvas(workflow: Workflow): Record<string, CanvasPoint> {
  const ids = new Set(workflow.steps.map((step) => step.id));
  const edges = canvasConnections(workflow).filter(
    (edge) => ids.has(edge.to) && edge.from !== edge.to,
  );
  const levels = new Map(workflow.steps.map((step) => [step.id, 0]));
  for (let pass = 0; pass < workflow.steps.length; pass++) {
    let changed = false;
    for (const edge of edges) {
      const next = Math.min(
        workflow.steps.length,
        (levels.get(edge.from) ?? 0) + 1,
      );
      if (next > (levels.get(edge.to) ?? 0)) {
        levels.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const rows = new Map<string, number>();
  const taken = new Map<number, Set<number>>();
  const claim = (id: string, wanted: number) => {
    const level = levels.get(id) ?? 0;
    const used = taken.get(level) ?? new Set<number>();
    let row = wanted;
    while (used.has(row)) row++;
    used.add(row);
    taken.set(level, used);
    rows.set(id, row);
    return row;
  };
  const outgoing = new Map<string, string[]>();
  for (const edge of edges)
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  const visit = (id: string, row: number) => {
    const own = claim(id, row);
    (outgoing.get(id) ?? []).forEach((child, index) => {
      if (!rows.has(child)) visit(child, own + index);
    });
  };
  if (ids.has(workflow.entry)) visit(workflow.entry, 0);
  const lowest = () => Math.max(-1, ...rows.values()) + 1;
  for (const step of workflow.steps)
    if (!rows.has(step.id)) visit(step.id, lowest());
  return Object.fromEntries(
    workflow.steps.map((step) => [
      step.id,
      {
        x: ORIGIN.x + (levels.get(step.id) ?? 0) * CANVAS_COLUMN,
        y: ORIGIN.y + (rows.get(step.id) ?? 0) * CANVAS_ROW,
      },
    ]),
  );
}

const overlaps = (a: CanvasPoint, b: CanvasPoint) =>
  Math.abs(a.x - b.x) < CANVAS_COLUMN * 0.75 &&
  Math.abs(a.y - b.y) < CANVAS_ROW * 0.75;
/** Positions for steps that have none yet, keeping every placed step where the
 * person left it. A step inserted into a connection pushes what follows to the
 * right; `hint` places the first new step where a connection was dropped. */
export function placeCanvasSteps(
  workflow: Workflow,
  known: Record<string, CanvasPoint>,
  hint?: CanvasPoint,
): Record<string, CanvasPoint> {
  const ids = new Set(workflow.steps.map((step) => step.id));
  const positions = Object.fromEntries(
    Object.entries(known).filter(([id]) => ids.has(id)),
  );
  const missing = workflow.steps.filter((step) => !positions[step.id]);
  if (!missing.length) return positions;
  // Nothing to keep, or a whole new graph (e.g. from the designer): lay it out.
  if (missing.length > 2 && missing.length * 2 > workflow.steps.length)
    return layoutCanvas(workflow);
  const edges = canvasConnections(workflow);
  for (const step of missing) {
    const incoming = edges.find(
      (edge) => edge.to === step.id && positions[edge.from],
    );
    const successor = edges.find(
      (edge) => edge.from === step.id && positions[edge.to],
    )?.to;
    let point: CanvasPoint;
    if (hint) {
      point = {
        x: snapToGrid(hint.x - CANVAS_NODE_SIZE / 2),
        y: snapToGrid(hint.y - CANVAS_NODE_SIZE / 2),
      };
      hint = undefined;
    } else if (incoming) {
      const from = positions[incoming.from]!;
      point = {
        x: from.x + CANVAS_COLUMN,
        y: from.y + (incoming.port === "whenFalse" ? CANVAS_ROW : 0),
      };
    } else if (successor) point = { ...positions[successor]! };
    else {
      const placed = Object.values(positions);
      point = placed.length
        ? {
            x: Math.max(...placed.map((p) => p.x)) + CANVAS_COLUMN,
            y: Math.min(...placed.map((p) => p.y)),
          }
        : { ...ORIGIN };
    }
    if (successor && overlaps(point, positions[successor]!)) {
      // Make room: everything downstream that is not left of the new step
      // moves one column to the right.
      const pending = [successor],
        moved = new Set<string>();
      while (pending.length) {
        const id = pending.pop()!;
        if (moved.has(id) || id === step.id || !positions[id]) continue;
        if (positions[id]!.x < point.x) continue;
        moved.add(id);
        pending.push(
          ...edges.filter((edge) => edge.from === id).map((edge) => edge.to),
        );
      }
      for (const id of moved)
        positions[id] = {
          x: positions[id]!.x + CANVAS_COLUMN,
          y: positions[id]!.y,
        };
    }
    while (Object.values(positions).some((other) => overlaps(point, other)))
      point = { x: point.x, y: point.y + CANVAS_ROW };
    positions[step.id] = point;
  }
  return positions;
}

export function canvasBounds(
  positions: Record<string, CanvasPoint>,
  entry: string,
): CanvasBounds {
  const points = Object.values(positions);
  const start = positions[entry];
  if (start) points.push(triggerPosition(start));
  if (!points.length) return { x: 0, y: 0, width: 400, height: 240 };
  const overhang = (CANVAS_LABEL_WIDTH - CANVAS_NODE_SIZE) / 2;
  const x = Math.min(...points.map((point) => point.x)) - overhang;
  const y = Math.min(...points.map((point) => point.y));
  return {
    x,
    y,
    width:
      Math.max(...points.map((point) => point.x)) +
      CANVAS_NODE_SIZE +
      overhang -
      x,
    height:
      Math.max(...points.map((point) => point.y)) +
      CANVAS_NODE_SIZE +
      CANVAS_LABEL_HEIGHT -
      y,
  };
}

/** The smallest zoom an automatic fit uses. */
export const CANVAS_FIT_MIN_ZOOM = 0.5;

export function fitCanvas(
  bounds: CanvasBounds,
  size: { width: number; height: number },
): CanvasViewport {
  const availableWidth = Math.max(1, size.width - 64);
  const availableHeight = Math.max(1, size.height - 104);
  const fit = Math.min(
    1,
    availableWidth / bounds.width,
    availableHeight / bounds.height,
  );
  // Labels stay legible: a graph wider than that starts at its trigger and
  // the rest is a pan away.
  const zoom = Math.max(CANVAS_MIN_ZOOM, CANVAS_FIT_MIN_ZOOM, fit);
  const width = bounds.width * zoom,
    height = bounds.height * zoom;
  return {
    zoom,
    x:
      width <= availableWidth
        ? (size.width - width) / 2 - bounds.x * zoom
        : 32 - bounds.x * zoom,
    y:
      height <= availableHeight
        ? (size.height - height) / 2 - bounds.y * zoom - 12
        : 40 - bounds.y * zoom,
  };
}

/** Keep the world coordinate under the zoom anchor fixed. */
export function zoomCanvas(
  view: CanvasViewport,
  factor: number,
  anchor: CanvasPoint,
): CanvasViewport {
  const zoom = Math.max(
    CANVAS_MIN_ZOOM,
    Math.min(CANVAS_MAX_ZOOM, view.zoom * factor),
  );
  const ratio = zoom / view.zoom;
  return {
    zoom,
    x: anchor.x - (anchor.x - view.x) * ratio,
    y: anchor.y - (anchor.y - view.y) * ratio,
  };
}

/** Whether one output may lead to a step; a refused connection keeps the old one. */
export function canvasConnectionProblem(
  workflow: Workflow,
  from: string,
  to: string,
  port: CanvasPort,
): "invalid" | "cycle" | null {
  const source = workflow.steps.find((step) => step.id === from);
  if (
    !source ||
    !workflow.steps.some((step) => step.id === to) ||
    source.type === "return" ||
    (source.type === "branch" ? port === "next" : port !== "next")
  )
    return "invalid";
  if (from === to) return "cycle";
  const successors = new Map<string, string[]>();
  for (const edge of canvasConnections(workflow)) {
    if (edge.from === from && edge.port === port) continue;
    successors.set(edge.from, [...(successors.get(edge.from) ?? []), edge.to]);
  }
  const pending = [to],
    visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === from) return "cycle";
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(...(successors.get(id) ?? []));
  }
  return null;
}

/** Output handles sit on the right edge; a condition's exits split it in thirds. */
export function canvasPortY(port: CanvasPort) {
  return port === "whenTrue"
    ? CANVAS_NODE_SIZE / 3
    : port === "whenFalse"
      ? (CANVAS_NODE_SIZE * 2) / 3
      : CANVAS_NODE_SIZE / 2;
}
export const canvasOutput = (from: CanvasPoint, port: CanvasPort) => ({
  x: from.x + CANVAS_NODE_SIZE,
  y: from.y + canvasPortY(port),
});
export const canvasInput = (to: CanvasPoint) => ({
  x: to.x,
  y: to.y + CANVAS_NODE_SIZE / 2,
});

/** A connection between two points: a curve forwards, and a route beneath both
 * steps when the target sits behind the source. `middle` anchors the edge toolbar. */
export function canvasWire(
  start: CanvasPoint,
  end: CanvasPoint,
  below = Math.max(start.y, end.y) + CANVAS_NODE_SIZE / 2 + 40,
): { path: string; middle: CanvasPoint } {
  if (end.x > start.x + 32) {
    const bend = Math.max(40, (end.x - start.x) / 2);
    return {
      path: `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}`,
      middle: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
    };
  }
  const out = start.x + 32,
    back = end.x - 32;
  return {
    path: `M ${start.x} ${start.y} C ${out + 16} ${start.y}, ${out} ${below}, ${out - 24} ${below} L ${back + 24} ${below} C ${back} ${below}, ${back - 16} ${end.y}, ${end.x} ${end.y}`,
    middle: { x: (out + back) / 2, y: below },
  };
}
export function canvasEdgePath(
  from: CanvasPoint,
  to: CanvasPoint,
  port: CanvasPort,
) {
  return canvasWire(
    canvasOutput(from, port),
    canvasInput(to),
    Math.max(from.y, to.y) +
      CANVAS_NODE_SIZE +
      CANVAS_LABEL_HEIGHT +
      (port === "whenFalse" ? 24 : 8),
  );
}
