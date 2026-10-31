import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { PetFallbackDrawing } from "../packages/ui/pet-fallback-drawing";
import { WebPetView } from "../apps/server-admin/web/app/pet-view";
const mockDraw = jest.fn(),
  mockDispose = jest.fn();
jest.mock("../packages/ui/pet-shader", () => ({
  createPetShader: () => ({ draw: mockDraw, dispose: mockDispose }),
}));
test("web canvas caps resolution and stops animation when paused or hidden", () => {
  const listeners = new Map<string, () => void>();
  let callback: FrameRequestCallback | undefined;
  const media = {
    matches: false,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  };
  global.window = {
    devicePixelRatio: 3,
    matchMedia: () => media,
  } as unknown as Window & typeof globalThis;
  global.document = {
    visibilityState: "visible",
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
    removeEventListener: jest.fn(),
  } as unknown as Document;
  global.requestAnimationFrame = jest.fn((fn) => {
    callback = fn;
    return 1;
  });
  global.cancelAnimationFrame = jest.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({}),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  };
  let view!: TestRenderer.ReactTestRenderer;
  act(() => {
    view = TestRenderer.create(<WebPetView size={800} animate={false} />, {
      createNodeMock: (element) => (element.type === "canvas" ? canvas : {}),
    });
  });
  expect(canvas.width).toBeLessThanOrEqual(480);
  expect(callback).toBeDefined();
  act(() => callback!(16));
  expect(mockDraw).toHaveBeenCalled();
  expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, "visibilityState", {
    value: "hidden",
    configurable: true,
  });
  act(() => listeners.get("visibilitychange")!());
  expect(cancelAnimationFrame).toHaveBeenCalled();
  act(() => view.unmount());
  expect(mockDispose).toHaveBeenCalledTimes(1);
});

test("idle no-GL appearance replacement settles immediately without a repeating frame", () => {
  global.window = {
    devicePixelRatio: 1,
    matchMedia: () => ({
      matches: false,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    }),
  } as unknown as Window & typeof globalThis;
  global.document = {
    visibilityState: "visible",
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  } as unknown as Document;
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  global.requestAnimationFrame = jest.fn((fn: FrameRequestCallback) => {
    frames.set(++next, fn);
    return next;
  });
  global.cancelAnimationFrame = jest.fn((id: Parameters<typeof cancelAnimationFrame>[0]) => {
    if (id != null) frames.delete(id);
  });
  const canvas = {
    getContext: () => null,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  };
  let view!: TestRenderer.ReactTestRenderer;
  const flush = () =>
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((fn) => fn(1000));
    });
  act(() => {
    view = TestRenderer.create(
      <WebPetView appearance={{ shape: "circle" }} />,
      { createNodeMock: (e) => (e.type === "canvas" ? canvas : {}) },
    );
  });
  flush();
  act(() => view.update(<WebPetView appearance={{ shape: "flower" }} />));
  flush();
  const fallback = view.root.findByType(PetFallbackDrawing);
  expect(fallback.props.geometry.mix).toBe(1);
  expect(fallback.props.geometry.a.n).toBe(6);
  expect(frames.size).toBe(0);
  act(() => view.unmount());
});
