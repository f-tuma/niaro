import { tokens as t } from "../packages/design-tokens";
import { petHash } from "../packages/ui/pet-hash";
import { PET_COUNTS } from "../packages/ui/pet-motion";
import { PET_SHADER_SOURCE } from "../packages/ui/pet-shader";
import {
  BUNDLED_STILL_VERSION,
  keepPetSnapshot,
  keptPetSnapshot,
  petShaderVersion,
  petStill,
  petSnapshotFile,
  petSnapshotKey,
  type PetSnapshotLook,
} from "../packages/ui/pet-snapshot";

// Nothing saved on this "device": only what the test keeps, and the bundled still.
jest.mock("../packages/ui/pet-snapshot-io", () => ({
  savedPetSnapshots: () => [],
}));

const look: PetSnapshotLook = {
  appearance: { shape: "clover", tint: [0.62, 0.86, 0.78], counts: [4, 1, 0] },
  background: "#141518",
  state: "idle",
  pixels: 330,
  reduced: false,
};

test("every input of the first frame changes the snapshot key", () => {
  const base = petSnapshotKey(look);
  const changed: Partial<PetSnapshotLook>[] = [
    { appearance: { ...look.appearance, shape: "heart" } },
    { appearance: { ...look.appearance, tint: [0.62, 0.86, 0.79] } },
    { appearance: { ...look.appearance, counts: [4, 1, 1] } },
    { background: "#FFFFFF" },
    { state: "resting" },
    { pixels: 210 },
  ];
  const keys = changed.map((change) => petSnapshotKey({ ...look, ...change }));
  expect(new Set([base, ...keys]).size).toBe(changed.length + 1);
  // The shader's own version is part of it: a new renderer never shows an old frame.
  expect(base!.startsWith(petShaderVersion() + "|")).toBe(true);
  expect(petShaderVersion()).toBe(petHash(PET_SHADER_SOURCE));
});

test("only frames a new pet always draws are kept: no busy states, no reduced motion", () => {
  for (const state of ["listening", "working", "speaking"] as const)
    expect(petSnapshotKey({ ...look, state })).toBeNull();
  expect(petSnapshotKey({ ...look, reduced: true })).toBeNull();
  expect(petSnapshotKey({ ...look, state: "resting" })).not.toBeNull();
});

test("the default look keys the same whether spelled out or omitted", () => {
  const omitted = petSnapshotKey({ ...look, appearance: undefined });
  const explicit = petSnapshotKey({
    ...look,
    appearance: {
      shape: "cookie",
      tint: [0.74, 0.7, 0.98],
      counts: PET_COUNTS,
    },
  });
  expect(omitted).toBe(explicit);
  expect(petSnapshotKey({ ...look, background: "#ABCDEF" })).toBe(
    petSnapshotKey({ ...look, background: "#abcdef" }),
  );
});

test("a saved snapshot is found by key and named by a stable file", () => {
  const key = petSnapshotKey(look)!;
  expect(petSnapshotFile(key)).toBe(petSnapshotFile(key));
  expect(petSnapshotFile(key)).toMatch(/^pet-[0-9a-z]+-idle-[0-9a-z]+\.png$/);
  expect(petSnapshotFile(key)).not.toBe(
    petSnapshotFile(petSnapshotKey({ ...look, pixels: 331 })!),
  );
  expect(keptPetSnapshot(key)).toBeNull();
  expect(petStill(look)).toBeNull();
  keepPetSnapshot(key, "file:///TEST/pet.png");
  expect(petStill(look)).toEqual({
    source: "file:///TEST/pet.png",
    exact: true,
  });
});

test("a look without its own still borrows its body's nearest one at once (NIAR-277)", () => {
  const body = {
    appearance: { shape: "flower" as const, tint: [0.4, 0.5, 0.9] },
    background: "#141518",
    pixels: 330,
    reduced: false,
  };
  const resting = petSnapshotKey({ ...body, state: "resting" })!;
  keepPetSnapshot(resting, "file:///TEST/flower-resting.png");
  // Only a resting still of this body: better than nothing for an idle pet.
  expect(petStill({ ...body, state: "idle" })).toEqual({
    source: "file:///TEST/flower-resting.png",
    exact: false,
  });
  const idle = petSnapshotKey({
    ...body,
    appearance: { ...body.appearance, counts: [9, 0, 0, 0, 0, 0] },
    state: "idle",
  })!;
  keepPetSnapshot(idle, "file:///TEST/flower-idle-old-ink.png");
  // Other ink, another size, a busy state or reduced motion: the same body in the nearest state.
  for (const other of [
    { ...body, state: "idle" as const, pixels: 210 },
    { ...body, state: "listening" as const },
    { ...body, state: "idle" as const, reduced: true },
  ])
    expect(petStill(other)).toEqual({
      source: "file:///TEST/flower-idle-old-ink.png",
      exact: false,
    });
  expect(petStill({ ...body, state: "resting" })).toEqual({
    source: "file:///TEST/flower-resting.png",
    exact: true,
  });
  // Another colour or another card is another body.
  expect(
    petStill({
      ...body,
      appearance: { ...body.appearance, tint: [0.9, 0.5, 0.4] },
      state: "idle",
    }),
  ).toBeNull();
  expect(
    petStill({ ...body, background: "#FFFFFF", state: "idle" }),
  ).toBeNull();
});

test("the bundled still was rendered from this shader (else run scripts/render-pet-still.ts)", () => {
  expect(BUNDLED_STILL_VERSION).toBe(petShaderVersion());
});

test("the bundled still stands in for the default pet on the app's card, at any size and ink", () => {
  const first = {
    background: t.color.background,
    state: "idle" as const,
    reduced: false,
  };
  for (const pixels of [300, 330, 66])
    expect(petStill({ ...first, pixels })?.exact).toBe(true);
  // The same body otherwise: near, so it cross-fades a little longer.
  expect(petStill({ ...first, pixels: 300, state: "resting" })?.exact).toBe(
    false,
  );
  expect(
    petStill({
      ...first,
      pixels: 300,
      appearance: { counts: [1, 1, 1, 1, 1, 1] },
    })?.exact,
  ).toBe(false);
  expect(petStill({ ...first, pixels: 300, background: "#FFFFFF" })).toBeNull();
  expect(
    petStill({ ...first, pixels: 300, appearance: { shape: "heart" } }),
  ).toBeNull();
});
