import React from "react";
import { Image, PixelRatio } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { tokens as t } from "../packages/design-tokens";
import { PetView } from "../packages/ui/PetView";
import { PetFallback } from "../packages/ui/PetFallback";
import { createPetShader } from "../packages/ui/pet-shader";
import { petRenderSize, type PetMotion } from "../packages/ui/pet-motion";
import {
  keepPetSnapshot,
  petSnapshotFile,
  petSnapshotKey,
} from "../packages/ui/pet-snapshot";
import { glSettled, savePetSnapshot } from "../packages/ui/pet-snapshot-io";

type Renderer = {
  compiling: jest.Mock;
  finish: jest.Mock;
  draw: jest.Mock;
  dispose: jest.Mock;
};
jest.mock("../packages/ui/pet-shader", () => ({
  PET_SHADER_SOURCE: "TEST shader",
  createPetShader: jest.fn(
    (): Renderer => ({
      compiling: jest.fn(() => false),
      finish: jest.fn(),
      draw: jest.fn(),
      dispose: jest.fn(),
    }),
  ),
}));
jest.mock("../packages/ui/pet-snapshot-io", () => ({
  canSavePetSnapshot: () => true,
  glSettled: jest.fn(),
  savedPetSnapshots: () => [],
  savePetSnapshot: jest.fn(),
}));
jest.mock("../packages/ui/motion", () => ({
  useReducedMotion: () => false,
}));
const mounts = { count: 0 };
jest.mock("../packages/ui/gl-surface", () => {
  const React = jest.requireActual("react");
  const { View } = jest.requireActual("react-native");
  function TestSurface(props: object) {
    React.useEffect(() => {
      mounts.count++;
    }, []);
    return React.createElement(View, { ...props, testID: "pet-gl" });
  }
  return {
    supportedGLView: () => TestSurface,
    GLBoundary: ({ children }: { children: React.ReactNode }) => children,
  };
});

const frames = new Map<number, FrameRequestCallback>();
let id = 0,
  now = 1000;
beforeEach(() => {
  frames.clear();
  mounts.count = 0;
  jest.mocked(createPetShader).mockClear();
  jest.mocked(glSettled).mockReset().mockResolvedValue(undefined);
  jest.mocked(savePetSnapshot).mockReset().mockResolvedValue(null);
  jest.spyOn(global, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++id, callback);
    return id;
  });
  jest.spyOn(global, "cancelAnimationFrame").mockImplementation((key) => {
    if (key != null) frames.delete(key);
  });
});
afterEach(() => jest.restoreAllMocks());
const advance = (count = 1) =>
  act(() => {
    for (let i = 0; i < count; i++) {
      now += 40;
      const entry = frames.entries().next().value;
      if (!entry) return;
      frames.delete(entry[0]);
      entry[1](now);
    }
  });
const gl = () => ({ endFrameEXP: jest.fn() });
function start(index = -1) {
  const context = gl();
  act(() =>
    screen
      .getAllByTestId("pet-gl", { includeHiddenElements: true })
      .at(index)!
      .props.onContextCreate(context),
  );
  const renderer = jest.mocked(createPetShader).mock.results.at(-1)!
    .value as Renderer;
  return { context, renderer };
}
const settle = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
const look = { shape: "circle" as const };
const pixels = (size: number) => petRenderSize(size, PixelRatio.get()).pixels;

test("the shader compiles off the JS thread: nothing waits for it until the GL thread is done", async () => {
  let done!: () => void;
  jest.mocked(glSettled).mockReturnValue(new Promise((r) => (done = r)));
  render(<PetView appearance={look} />);
  const { context, renderer } = start();
  // Queued and handed to the GL thread, never asked about yet.
  expect(createPetShader).toHaveBeenCalledWith(
    context,
    t.color.background,
    true,
  );
  expect(context.endFrameEXP).toHaveBeenCalledTimes(1);
  expect(renderer.finish).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
  await act(async () => done());
  expect(renderer.finish).toHaveBeenCalledTimes(1);
  advance();
  expect(renderer.draw).toHaveBeenCalledTimes(1);
});

test("a shader that fails to compile still leaves the still drawing", async () => {
  render(<PetView appearance={look} />);
  const { renderer } = start();
  renderer.finish.mockImplementation(() => {
    throw Error("Pet shader compile failed");
  });
  await settle();
  expect(renderer.dispose).toHaveBeenCalled();
  expect(screen.UNSAFE_queryAllByType(PetFallback)).toHaveLength(1);
});

test("the first frame of a new pet is saved once, with nothing drawn over it meanwhile", async () => {
  let saved!: (uri: string) => void;
  jest.mocked(savePetSnapshot).mockReturnValue(new Promise((r) => (saved = r)));
  const key = petSnapshotKey({
    appearance: { shape: "pill" },
    background: t.color.background,
    state: "idle",
    pixels: pixels(156),
    reduced: false,
  })!;
  const { unmount } = render(<PetView appearance={{ shape: "pill" }} />);
  const { context, renderer } = start();
  await settle();
  advance();
  expect(renderer.draw).toHaveBeenCalledTimes(1);
  expect(savePetSnapshot).toHaveBeenCalledWith(context, petSnapshotFile(key));
  expect(frames.size).toBe(0);
  await act(async () => saved("file:///TEST/pill.png"));
  advance();
  expect(renderer.draw).toHaveBeenCalledTimes(2);
  unmount();
  // The next pet with that look shows it at once, and does not save it again.
  render(<PetView appearance={{ shape: "pill" }} />);
  expect(screen.UNSAFE_getByType(Image).props.source).toEqual({
    uri: "file:///TEST/pill.png",
  });
  start();
  await settle();
  advance();
  expect(savePetSnapshot).toHaveBeenCalledTimes(1);
});

test("a kept still stands in until the live pet draws; the drawing only covers its decoding", async () => {
  jest.useFakeTimers({
    doNotFake: ["requestAnimationFrame", "cancelAnimationFrame"],
  });
  try {
    keepPetSnapshot(
      petSnapshotKey({
        appearance: { shape: "flower" },
        background: t.color.background,
        state: "resting",
        pixels: pixels(156),
        reduced: false,
      })!,
      "file:///TEST/flower.png",
    );
    render(<PetView appearance={{ shape: "flower" }} state="resting" />);
    expect(
      screen.getByTestId("niaro-pet-still", { includeHiddenElements: true }),
    ).toBeTruthy();
    fireEvent(screen.UNSAFE_getByType(Image), "load");
    act(() => jest.advanceTimersByTime(5000));
    expect(screen.UNSAFE_queryAllByType(PetFallback)).toHaveLength(0);
    expect(
      screen.getByTestId("niaro-pet-still", { includeHiddenElements: true }),
    ).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});

// The opacity of the live surface's own layer: 0 while something stands in for it.
const surfaceShown = () => {
  let node = screen.getByTestId("pet-gl", {
    includeHiddenElements: true,
  }).parent;
  while (node && node.props.style?.opacity === undefined) node = node.parent;
  return node?.props.style.opacity === 1;
};

test("nothing draws before the shader is finished, even when a prop change wakes the pet (NIAR-277)", async () => {
  let done!: () => void;
  jest.mocked(glSettled).mockReturnValueOnce(new Promise((r) => (done = r)));
  const { rerender } = render(<PetView appearance={look} />);
  const { renderer } = start();
  // A screen opening re-renders the pet while the GL thread still compiles.
  rerender(<PetView appearance={look} occupied />);
  advance(3);
  expect(renderer.draw).not.toHaveBeenCalled();
  expect(surfaceShown()).toBe(false);
  expect(
    screen.getByTestId("niaro-pet-still", { includeHiddenElements: true }),
  ).toBeTruthy();
  await act(async () => done());
  advance();
  expect(renderer.draw).toHaveBeenCalledTimes(1);
});

test("the stand-in leaves only once the GL thread has drawn the first frame", async () => {
  keepPetSnapshot(
    petSnapshotKey({
      appearance: look,
      background: t.color.background,
      state: "idle",
      pixels: pixels(156),
      reduced: false,
    })!,
    "file:///TEST/circle.png",
  );
  render(<PetView appearance={look} />);
  const { renderer } = start();
  await settle(); // compiled
  let drawn!: () => void;
  jest.mocked(glSettled).mockReturnValueOnce(new Promise((r) => (drawn = r)));
  advance();
  expect(renderer.draw).toHaveBeenCalledTimes(1);
  // JS asked for the frame; the GL thread may not have drawn it yet.
  expect(surfaceShown()).toBe(false);
  await act(async () => drawn());
  expect(surfaceShown()).toBe(true);
});

test("a hidden pet draws its first frame (and keeps its still), then waits to be shown", async () => {
  const { rerender } = render(
    <PetView appearance={{ shape: "burst" }} visible={false} />,
  );
  const { renderer } = start();
  await settle();
  advance();
  expect(renderer.draw).toHaveBeenCalledTimes(1);
  expect(savePetSnapshot).toHaveBeenCalledTimes(1);
  await settle();
  advance(5);
  expect(renderer.draw).toHaveBeenCalledTimes(1);
  rerender(<PetView appearance={{ shape: "burst" }} visible />);
  advance(2);
  expect(renderer.draw).toHaveBeenCalledTimes(3);
});

test("a look without its own still borrows the nearest one of the same body", () => {
  keepPetSnapshot(
    petSnapshotKey({
      appearance: { shape: "sunny", counts: [4, 0, 0, 0, 0, 0] },
      background: t.color.background,
      state: "idle",
      pixels: 999,
      reduced: false,
    })!,
    "file:///TEST/sunny-old-ink.png",
  );
  render(
    <PetView appearance={{ shape: "sunny", counts: [1, 2, 3, 0, 0, 0] }} />,
  );
  expect(screen.UNSAFE_getByType(Image).props.source).toEqual({
    uri: "file:///TEST/sunny-old-ink.png",
  });
});

test("a rebuilt pet under the same key continues; a second pet on screen has its own motion", async () => {
  const motionOf = (renderer: Renderer) =>
    renderer.draw.mock.calls.at(-1)![0] as PetMotion;
  const first = render(<PetView appearance={look} motionKey="TEST-home" />);
  const a = start();
  await settle();
  advance(); // the first frame, saved as this look's still
  await settle();
  advance(10);
  const time = motionOf(a.renderer).time;
  expect(time).toBeGreaterThan(2.3);
  first.unmount();

  render(
    <>
      <PetView appearance={look} motionKey="TEST-home" testID="again" />
      <PetView appearance={look} motionKey="TEST-home" testID="preview" />
    </>,
  );
  const again = start(0);
  const preview = start(1);
  await settle();
  advance(2);
  expect(motionOf(again.renderer).time).toBe(time);
  expect(motionOf(preview.renderer).time).toBe(2);
  expect(motionOf(preview.renderer)).not.toBe(motionOf(again.renderer));
});

test("a size change only scales the drawing; a much larger one draws anew", () => {
  const { rerender } = render(
    <PetView appearance={look} size={220} drawingSize={220} />,
  );
  expect(mounts.count).toBe(1);
  rerender(<PetView appearance={look} size={140} drawingSize={220} />);
  expect(mounts.count).toBe(1);
  const gl = screen.getByTestId("pet-gl", { includeHiddenElements: true });
  expect(gl.props.style).toEqual({
    width: pixels(220) / PixelRatio.get(),
    height: pixels(220) / PixelRatio.get(),
  });
  rerender(<PetView appearance={look} size={120} />);
  expect(mounts.count).toBe(1);
  rerender(<PetView appearance={look} size={400} />);
  expect(mounts.count).toBe(2);
});
