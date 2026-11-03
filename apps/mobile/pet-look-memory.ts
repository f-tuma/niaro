import { PET_SHAPES, type PetAppearance } from "../../packages/ui/pet-motion";
import type { PetProfileCache } from "./pet-profile-model";

/**
 * The pet's look from the last run, read when the app starts, so the app's one pet is created in
 * its own look before the profile (or even the session) is back (NIAR-277). Any profile replaces it.
 */
const KEY = "niaro.petLook";

export async function loadPetLook(
  storage: Pick<PetProfileCache, "getItem">,
): Promise<PetAppearance | null> {
  try {
    const stored = await storage.getItem(KEY);
    if (!stored) return null;
    const value = JSON.parse(stored) as PetAppearance;
    const numbers = (list: unknown) =>
      Array.isArray(list) && list.every((n) => typeof n === "number");
    if (
      typeof value !== "object" ||
      !value ||
      (value.shape !== undefined && !Object.hasOwn(PET_SHAPES, value.shape)) ||
      (value.tint !== undefined && !numbers(value.tint)) ||
      (value.counts !== undefined && !numbers(value.counts))
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

export function savePetLook(
  storage: Pick<PetProfileCache, "setItem" | "removeItem">,
  look: PetAppearance | null,
) {
  void (
    look ? storage.setItem(KEY, JSON.stringify(look)) : storage.removeItem(KEY)
  ).catch(() => {});
}
