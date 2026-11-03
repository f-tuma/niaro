import { loadPetLook, savePetLook } from "../apps/mobile/pet-look-memory";
import { petPlacement } from "../packages/ui/pet-stage-place";

const stage = { pageX: 0, pageY: 0, width: 400, height: 800 };

test("the pet is scaled about its centre onto the slot's centre", () => {
  const slot = { pageX: 90, pageY: 200, width: 220, height: 220 };
  const place = petPlacement(stage, stage, slot, 220);
  expect(place).toMatchObject({ outerX: 0, outerY: 0, innerX: 0, innerY: 0 });
  expect(place.petX).toBe(90);
  expect(place.petY).toBe(200);
  expect(place.scale).toBe(1);
  // A 44 pt top-bar slot: the same pet, a fifth of its size, centred on it.
  const small = petPlacement(
    stage,
    stage,
    { pageX: 60, pageY: 10, width: 44, height: 44 },
    220,
  );
  expect(small.scale).toBe(0.2);
  expect(small.petX + 110).toBe(60 + 22);
  expect(small.petY + 110).toBe(10 + 22);
});

test("two clipping layers let through exactly the scrolling area, and the pet stays put on screen", () => {
  const area = { pageX: 0, pageY: 120, width: 400, height: 560 };
  const slot = { pageX: 90, pageY: 80, width: 220, height: 220 };
  const place = petPlacement(stage, area, slot, 220);
  // Outer layer: starts at the area's top-left; inner: ends at its bottom-right.
  const innerLeft = place.outerX + place.innerX,
    innerTop = place.outerY + place.innerY;
  expect([place.outerX, place.outerY]).toEqual([0, 120]);
  expect(innerLeft + stage.width).toBe(400);
  expect(innerTop + stage.height).toBe(680);
  // Through both layers, the pet lands where the slot is.
  expect(innerLeft + place.petX).toBe(90);
  expect(innerTop + place.petY).toBe(80);
});

test("the last look is remembered for the next start; a damaged one is ignored", async () => {
  const items = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => items.get(key) ?? null,
    setItem: async (key: string, value: string) => void items.set(key, value),
    removeItem: async (key: string) => void items.delete(key),
  };
  expect(await loadPetLook(storage)).toBeNull();
  const look = {
    shape: "heart" as const,
    tint: [0.5, 0.6, 0.7],
    counts: [1, 2],
  };
  savePetLook(storage, look);
  await Promise.resolve();
  expect(await loadPetLook(storage)).toEqual(look);
  items.set("niaro.petLook", JSON.stringify({ shape: "teapot" }));
  expect(await loadPetLook(storage)).toBeNull();
  items.set("niaro.petLook", "{");
  expect(await loadPetLook(storage)).toBeNull();
  savePetLook(storage, null);
  await Promise.resolve();
  expect(items.has("niaro.petLook")).toBe(false);
});
