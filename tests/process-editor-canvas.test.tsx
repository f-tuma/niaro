import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import {
  ProcessEditorCanvas,
  type ProcessEditorCanvasProps,
} from "../apps/server-admin/web/process-editor-canvas";
import { editorEn } from "../apps/server-admin/web/process-editor-copy";
import type { Workflow } from "../apps/server-admin/web/lib/process-editor";
import {
  CANVAS_COLUMN,
  canvasBounds,
  canvasConnectionProblem,
  canvasEdgePath,
  fitCanvas,
  layoutCanvas,
  placeCanvasSteps,
  zoomCanvas,
} from "../apps/server-admin/web/lib/process-canvas";
import {
  disconnectStep,
  insertStep,
  attachStep,
} from "../apps/server-admin/web/lib/process-editor";
import {
  designUiCandidate,
  designUiCapabilities,
} from "./admin-design-fixtures";

jest.mock(
  "@admin/components/ui/button",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return {
      Button: (props: React.ComponentProps<"button">) =>
        React.createElement("button", props),
    };
  },
  { virtual: true },
);

const trees: TestRenderer.ReactTestRenderer[] = [];
afterEach(() => act(() => trees.splice(0).forEach((tree) => tree.unmount())));
function workflow(): Workflow {
  const value = structuredClone(designUiCandidate);
  if (value.kind !== "workflow") throw new Error("TEST expected workflow");
  return value;
}
function fixture(
  overrides: Partial<ProcessEditorCanvasProps> = {},
  width = 390,
) {
  const props: ProcessEditorCanvasProps = {
    workflow: workflow(),
    capabilities: designUiCapabilities,
    selected: "lookup",
    disabled: false,
    copy: editorEn,
    onSelect: jest.fn(),
    onConnect: jest.fn(),
    onEntry: jest.fn(),
    onDisconnect: jest.fn(),
    onAdd: jest.fn(),
    onDelete: jest.fn(),
    onUndo: jest.fn(),
    onRedo: jest.fn(),
    ...overrides,
  };
  const pointerHost = {
    setPointerCapture: jest.fn(),
    hasPointerCapture: () => true,
    releasePointerCapture: jest.fn(),
  };
  let tree: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<ProcessEditorCanvas {...props} />, {
      createNodeMock: (element) =>
        (element.props as Record<string, unknown>)["data-testid"] ===
        "process-editor-canvas"
          ? {
              ...pointerHost,
              getBoundingClientRect: () => ({ width, height: 600 }),
            }
          : null,
    });
  });
  trees.push(tree!);
  const region = () =>
    tree.root.findByProps({ "data-testid": "process-editor-canvas" });
  const button = (label: string) =>
    tree.root
      .findAllByType("button")
      .find((item) => item.props["aria-label"] === label)!;
  const click = (label: string) => act(() => button(label).props.onClick());
  const node = (id: string) => tree.root.findByProps({ "data-node-id": id });
  const key = (value: string, modifiers: Record<string, boolean> = {}) =>
    act(() =>
      region().props.onKeyDown({
        ...modifiers,
        key: value,
        target: pointerHost,
        currentTarget: pointerHost,
        preventDefault: jest.fn(),
      }),
    );
  const pointer = (x: number, y: number) => ({
    pointerId: 1,
    button: 0,
    clientX: x,
    clientY: y,
    target: { closest: () => null, getAttribute: () => null },
    currentTarget: pointerHost,
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
  });
  const scene = () => tree.root.findByProps({ "data-testid": "canvas-scene" });
  // Client coordinates of a canvas point under the current view.
  const client = (x: number, y: number) => {
    const [vx, vy, zoom] = scene()
      .props.style["--canvas-transform"].match(/[-.\d]+/g)!
      .map(Number);
    return { x: x * zoom! + vx!, y: y * zoom! + vy! };
  };
  const at = (id: string) => ({
    x: parseFloat(node(id).props.style["--node-x"]),
    y: parseFloat(node(id).props.style["--node-y"]),
  });
  const drag = (
    control: TestRenderer.ReactTestInstance,
    from: { x: number; y: number },
    to: { x: number; y: number },
  ) => {
    act(() => control.props.onPointerDown(pointer(from.x, from.y)));
    act(() => region().props.onPointerMove(pointer(from.x + 10, from.y + 10)));
    act(() => region().props.onPointerMove(pointer(to.x, to.y)));
    act(() => region().props.onPointerUp(pointer(to.x, to.y)));
  };
  return {
    tree: tree!,
    props,
    pointerHost,
    region,
    button,
    click,
    node,
    key,
    pointer,
    scene,
    client,
    at,
    drag,
    update: (next: Partial<ProcessEditorCanvasProps>) =>
      act(() => {
        Object.assign(props, next);
        tree.update(<ProcessEditorCanvas {...props} />);
      }),
  };
}

test("a 390px canvas begins fitted, keyboard navigation reveals offscreen nodes legibly, and fit restores the overview", () => {
  const f = fixture();
  const fit = fitCanvas(
    canvasBounds(layoutCanvas(f.props.workflow), f.props.workflow.entry),
    { width: 390, height: 600 },
  );
  // No step starts cut off on a phone.
  expect(f.scene().props.style["--canvas-transform"]).toContain(
    `scale(${fit.zoom})`,
  );
  act(() => f.node("finish").props.onFocus());
  expect(f.scene().props.style["--canvas-transform"]).toContain("scale(0.75)");
  const finish = f.client(f.at("finish").x, f.at("finish").y);
  expect(finish.x).toBeGreaterThanOrEqual(16);
  expect(finish.y).toBeGreaterThanOrEqual(16);
  f.click("Fit workflow");
  expect(f.scene().props.style["--canvas-transform"]).toContain(
    `scale(${fit.zoom})`,
  );
  const before = f.scene().props.style["--canvas-transform"];
  f.key("ArrowRight");
  expect(f.scene().props.style["--canvas-transform"]).not.toBe(before);
  f.key("+");
  expect(f.props.onSelect).not.toHaveBeenCalled();
  expect(f.props.onConnect).not.toHaveBeenCalled();
});

test("output handles reconnect by click or by dragging onto a step, and the start handle moves the entry", () => {
  const f = fixture();
  expect(f.button("Connect: explain").props.disabled).toBe(true);
  f.click(`Connect: check · ${editorEn.whenFalse}`);
  expect(f.button("Connect: explain").props.disabled).toBe(false);
  f.click("Connect: explain");
  expect(f.props.onConnect).toHaveBeenCalledWith(
    "check",
    "explain",
    "whenFalse",
  );
  expect(f.props.onSelect).not.toHaveBeenCalled();
  expect(
    f.tree.root
      .findAllByType("button")
      .every((button) => button.findAllByType("button").length === 1),
  ).toBe(true);

  const explain = f.at("explain");
  f.drag(
    f.button(`Connect: lookup · ${editorEn.next}`),
    { x: 0, y: 0 },
    f.client(explain.x + 10, explain.y + 40),
  );
  expect(f.props.onConnect).toHaveBeenLastCalledWith(
    "lookup",
    "explain",
    "next",
  );
  // The click that ends a drag does not start click-to-connect.
  f.click(`Connect: lookup · ${editorEn.next}`);
  expect(f.tree.root.findAllByProps({ role: "status" })).toHaveLength(0);

  const check = f.at("check");
  f.drag(
    f.button(`Connect: ${editorEn.manualTrigger}`),
    { x: 0, y: 0 },
    f.client(check.x + 40, check.y + 40),
  );
  expect(f.props.onEntry).toHaveBeenCalledWith("check");
});

test("dropping a connection on empty canvas asks for a step placed where it was dropped", () => {
  const f = fixture({}, 1200);
  const drop = { x: 900, y: 900 };
  f.drag(
    f.button(`Connect: explain · ${editorEn.next}`),
    { x: 0, y: 0 },
    f.client(drop.x, drop.y),
  );
  expect(f.props.onAdd).toHaveBeenCalledWith("explain", "next", {
    replace: true,
  });
  expect(f.props.onConnect).not.toHaveBeenCalled();
  f.update({
    workflow: attachStep(
      f.props.workflow,
      "explain",
      "next",
      "return",
      designUiCapabilities,
    ),
  });
  const placed = f.at("return_1");
  expect(Math.abs(placed.x + 48 - drop.x)).toBeLessThanOrEqual(12);
  expect(Math.abs(placed.y + 48 - drop.y)).toBeLessThanOrEqual(12);
});

test("connection toolbars insert or delete, and open outputs offer a plus", () => {
  const f = fixture();
  f.click(`${editorEn.addHere}: check/whenTrue`);
  expect(f.props.onAdd).toHaveBeenCalledWith("check", "whenTrue");
  f.click(`${editorEn.addHere}: start`);
  expect(f.props.onAdd).toHaveBeenCalledWith(null, "next");
  f.click(`${editorEn.deleteConnection}: lookup/next`);
  expect(f.props.onDisconnect).toHaveBeenCalledWith("lookup", "next");
  expect(
    f.tree.root
      .findAllByType("button")
      .filter((button) =>
        button.props["aria-label"]?.startsWith(`${editorEn.addAfter}:`),
      ),
  ).toHaveLength(0);
  f.update({
    workflow: disconnectStep(f.props.workflow, "explain", "next"),
    issues: [editorEn.openOutput],
  });
  f.click(`${editorEn.addAfter}: explain · ${editorEn.next}`);
  expect(f.props.onAdd).toHaveBeenLastCalledWith("explain", "next");
  expect(
    f.tree.root.findAll(
      (item) =>
        item.props["data-from"] === "explain" && item.props["data-port"],
    ),
  ).toHaveLength(0);
  expect(JSON.stringify(f.tree.toJSON())).toContain(editorEn.openOutput);
});

test("steps delete from their toolbar or the keyboard, and Ctrl+Z asks to undo", () => {
  const f = fixture();
  f.click(`${editorEn.remove}: explain`);
  expect(f.props.onDelete).toHaveBeenCalledWith("explain");
  act(() =>
    f.button(`${editorEn.select}: finish`).props.onKeyDown({
      key: "Delete",
      preventDefault: jest.fn(),
    }),
  );
  expect(f.props.onDelete).toHaveBeenLastCalledWith("finish");
  f.key("z", { ctrlKey: true });
  expect(f.props.onUndo).toHaveBeenCalledTimes(1);
  f.key("z", { ctrlKey: true, shiftKey: true });
  expect(f.props.onRedo).toHaveBeenCalledTimes(1);
});

test("cycle rejection and Escape cancellation do not change the workflow", () => {
  const f = fixture();
  f.click(`Connect: explain · ${editorEn.next}`);
  f.click(`${editorEn.select}: lookup`);
  expect(f.props.onConnect).not.toHaveBeenCalled();
  expect(JSON.stringify(f.tree.toJSON())).toContain(editorEn.cycle);
  f.key("Escape");
  expect(f.tree.root.findAllByProps({ role: "status" })).toHaveLength(0);
  f.click(`${editorEn.select}: finish`);
  expect(f.props.onSelect).toHaveBeenCalledWith("finish");
});

test("node dragging snaps to the grid, empty-canvas panning moves the view, and neither edits the process", () => {
  const f = fixture();
  const original = structuredClone(f.props.workflow);
  const left = f.at("lookup").x;
  act(() =>
    f
      .button(`${editorEn.select}: lookup`)
      .props.onPointerDown(f.pointer(100, 100)),
  );
  act(() => f.region().props.onPointerMove(f.pointer(160, 130)));
  act(() => f.region().props.onPointerUp(f.pointer(160, 130)));
  f.click(`${editorEn.select}: lookup`);
  // 60px at the legible minimum fit zoom (50%) is 120 canvas pixels, on the 24px grid.
  expect(f.at("lookup").x).toBe(left + 120);
  const position = f.node("lookup").props.style["--node-x"];
  f.update({
    workflow: { ...f.props.workflow, name: "TEST local presentation retained" },
  });
  expect(f.node("lookup").props.style["--node-x"]).toBe(position);
  const before = f.scene().props.style["--canvas-transform"];
  act(() => f.region().props.onPointerDown(f.pointer(0, 0)));
  act(() => f.region().props.onPointerMove(f.pointer(40, 25)));
  act(() => f.region().props.onPointerUp(f.pointer(40, 25)));
  expect(f.scene().props.style["--canvas-transform"]).not.toBe(before);
  expect(f.props.onSelect).not.toHaveBeenCalled();
  expect(f.props.onConnect).not.toHaveBeenCalled();
  expect(f.props.onAdd).not.toHaveBeenCalled();
  expect(original.steps).toEqual(f.props.workflow.steps);
  f.click(editorEn.tidy);
  expect(f.at("lookup").x).toBe(left);
});

test("disabling edits cancels a pending connector while leaving zoom controls usable", () => {
  const f = fixture();
  f.click(`Connect: check · ${editorEn.whenTrue}`);
  f.update({ disabled: true });
  expect(f.tree.root.findAllByProps({ role: "status" })).toHaveLength(0);
  expect(f.button(`${editorEn.select}: finish`).props.disabled).toBe(true);
  const before = f.scene().props.style["--canvas-transform"];
  f.click("Zoom in");
  expect(f.scene().props.style["--canvas-transform"]).not.toBe(before);
  expect(f.props.onConnect).not.toHaveBeenCalled();
});

test("human action and model labels retain unavailable references without substituting capabilities", () => {
  const f = fixture();
  expect(JSON.stringify(f.tree.toJSON())).toContain("Find contacts");
  expect(JSON.stringify(f.tree.toJSON())).toContain("TEST designer");
  f.update({
    capabilities: { ...designUiCapabilities, services: [], models: [] },
  });
  expect(f.button(`${editorEn.select}: lookup`).props.title).toContain(
    "test_action",
  );
  expect(f.button(`${editorEn.select}: lookup`).props.title).toContain(
    editorEn.unavailable,
  );
  expect(
    f.props.workflow.steps.find((step) => step.id === "lookup"),
  ).toMatchObject({ serviceId: "test_service", actionId: "test_action" });
});

test("connection validation refuses incompatible ports, missing nodes and new cycles but allows branch convergence", () => {
  const value = workflow();
  expect(canvasConnectionProblem(value, "finish", "lookup", "next")).toBe(
    "invalid",
  );
  expect(canvasConnectionProblem(value, "check", "finish", "next")).toBe(
    "invalid",
  );
  expect(canvasConnectionProblem(value, "lookup", "finish", "whenFalse")).toBe(
    "invalid",
  );
  expect(canvasConnectionProblem(value, "lookup", "missing", "next")).toBe(
    "invalid",
  );
  expect(canvasConnectionProblem(value, "explain", "lookup", "next")).toBe(
    "cycle",
  );
  expect(
    canvasConnectionProblem(value, "check", "explain", "whenFalse"),
  ).toBeNull();
  expect(
    canvasEdgePath({ x: 0, y: 0 }, { x: 240, y: 0 }, "whenTrue").path,
  ).not.toBe(
    canvasEdgePath({ x: 0, y: 0 }, { x: 240, y: 0 }, "whenFalse").path,
  );
});

test("zoom preserves the world point under its anchor and fit bounds include the manual start", () => {
  const current = { x: 12, y: -15, zoom: 0.75 },
    anchor = { x: 195, y: 300 };
  const next = zoomCanvas(current, 1.2, anchor);
  expect((anchor.x - next.x) / next.zoom).toBeCloseTo(
    (anchor.x - current.x) / current.zoom,
  );
  expect((anchor.y - next.y) / next.zoom).toBeCloseTo(
    (anchor.y - current.y) / current.zoom,
  );
  const positions = layoutCanvas(workflow());
  expect(canvasBounds(positions, "lookup").x).toBe(
    positions.lookup!.x - CANVAS_COLUMN - 40,
  );
});

test("layout splits condition exits into rows and inserted steps push what follows to the right", () => {
  const value = workflow();
  const layout = layoutCanvas(value);
  expect(layout.check!.y).toBe(layout.lookup!.y);
  expect(layout.explain!.y).toBe(layout.check!.y);
  expect(layout.finish!.x).toBeGreaterThan(layout.explain!.x);
  const inserted = insertStep(
    value,
    "lookup",
    "next",
    "return",
    designUiCapabilities,
  );
  const placed = placeCanvasSteps(inserted, layout);
  // A result cuts the path short; it takes the next free spot instead of
  // pushing the now unreachable steps aside.
  expect(placed.return_1!.x).toBe(layout.lookup!.x + CANVAS_COLUMN);
  expect(placed.return_1!.y).toBeGreaterThan(layout.check!.y);
  expect(placed.check).toEqual(layout.check);
  const grown = placeCanvasSteps(
    insertStep(value, "lookup", "next", "branch", designUiCapabilities),
    layout,
  );
  expect(grown.check!.x).toBe(layout.check!.x + CANVAS_COLUMN);
  expect(grown.finish!.x).toBe(layout.finish!.x + CANVAS_COLUMN);
  expect(grown.lookup).toEqual(layout.lookup);
});
