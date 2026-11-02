import { tokens as t } from "../packages/design-tokens";
import { petHash } from "../packages/ui/pet-hash";
import { PET_COUNTS } from "../packages/ui/pet-motion";
import { PET_SHADER_SOURCE } from "../packages/ui/pet-shader";
import {
  BUNDLED_STILL_VERSION,
  keepPetSnapshot,
  keptPetSnapshot,
  petShaderVersion,
  petSnapshot,
  petSnapshotFile,
  petSnapshotKey,
  type PetSnapshotLook,
} from "../packages/ui/pet-snapshot";

// Nothing saved on this "device": only what the test keeps, and the bundled still.
jest.mock("../packages/ui/pet-snapshot-io", () => ({
  savedPetSnapshot: () => null,
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
  expect(petSnapshotFile(key)).toMatch(/^pet-[0-9a-z]+\.png$/);
  expect(petSnapshotFile(key)).not.toBe(
    petSnapshotFile(petSnapshotKey({ ...look, pixels: 331 })!),
  );
  expect(keptPetSnapshot(key)).toBeNull();
  expect(petSnapshot(key)).toBeNull();
  keepPetSnapshot(key, "file:///TEST/pet.png");
  expect(petSnapshot(key)).toBe("file:///TEST/pet.png");
  expect(petSnapshot(null)).toBeNull();
});

test("the bundled still was rendered from this shader (else run scripts/render-pet-still.ts)", () => {
  expect(BUNDLED_STILL_VERSION).toBe(petShaderVersion());
});

test("the bundled still stands in only for the default pet on the app's card, at any size", () => {
  const first = {
    background: t.color.background,
    state: "idle" as const,
    reduced: false,
  };
  for (const pixels of [300, 330, 66])
    expect(petSnapshot(petSnapshotKey({ ...first, pixels }))).not.toBeNull();
  expect(
    petSnapshot(petSnapshotKey({ ...first, pixels: 300, state: "resting" })),
  ).toBeNull();
  expect(
    petSnapshot(
      petSnapshotKey({ ...first, pixels: 300, background: "#FFFFFF" }),
    ),
  ).toBeNull();
  expect(
    petSnapshot(
      petSnapshotKey({ ...first, pixels: 300, appearance: { shape: "heart" } }),
    ),
  ).toBeNull();
});
