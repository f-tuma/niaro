import { tokens as t } from "../design-tokens";
import { PET_COUNTS, type PetAppearance, type PetState } from "./pet-motion";
import { petHash } from "./pet-hash";
import { PET_SHADER_SOURCE } from "./pet-shader";
import { savedPetSnapshot } from "./pet-snapshot-io";

/**
 * Stills of a pet's first live frame, shown the moment a pet mounts while its shader compiles.
 * That frame depends only on the look, the card behind it, rest or not, and the drawing size
 * (the clock starts at 2, nothing has touched it), so a still taken once looks exactly like the
 * live pet that replaces it. Busy states and reduced motion are not kept.
 */
export type PetSnapshot = number | string; // a bundled image, or a file or blob URI

let version: string | undefined;
export function petShaderVersion() {
  return (version ??= petHash(String(PET_SHADER_SOURCE ?? "")));
}
const DEFAULT_TINT = [0.74, 0.7, 0.98];

export type PetSnapshotLook = {
  appearance?: PetAppearance;
  background: string;
  state: PetState;
  /** Drawing buffer width in device pixels. */
  pixels: number;
  reduced: boolean;
};
/** The cache key of a first frame, or null when that frame is not worth keeping. */
export function petSnapshotKey(look: PetSnapshotLook): string | null {
  if (look.reduced || (look.state !== "idle" && look.state !== "resting"))
    return null;
  const a = look.appearance;
  return [
    petShaderVersion(),
    a?.shape ?? "cookie",
    (a?.tint ?? DEFAULT_TINT).map((value) => value.toFixed(4)).join(","),
    (a?.counts ?? PET_COUNTS).join(","),
    look.background.toLowerCase(),
    look.state,
    Math.round(look.pixels),
  ].join("|");
}
export function petSnapshotFile(key: string) {
  return `pet-${petHash(key)}.png`;
}

// The pet before pairing and before the profile arrives: the default look on the app's card,
// rendered once by scripts/render-pet-still.mjs from this shader. A changed shader no longer
// matches its version, so it is not shown until it is rendered again (a test says so).
export const BUNDLED_STILL_VERSION = "1xvzs73";
function bundled(key: string): PetSnapshot | null {
  if (BUNDLED_STILL_VERSION !== petShaderVersion()) return null;
  const base = petSnapshotKey({
    background: t.color.background,
    state: "idle",
    pixels: 0,
    reduced: false,
  })!.replace(/\|0$/, "|");
  if (!key.startsWith(base)) return null;
  return require("./assets/pet-still.png") as number;
}

const kept = new Map<string, string | null>();
/** A snapshot this device saved for key (memory, then the cache folder). */
export function keptPetSnapshot(key: string | null): string | null {
  if (!key) return null;
  let uri = kept.get(key);
  if (uri === undefined) {
    uri = savedPetSnapshot(petSnapshotFile(key));
    kept.set(key, uri);
  }
  return uri;
}
/** What to show for key until the live pet draws: a saved snapshot, else the bundled one. */
export function petSnapshot(key: string | null): PetSnapshot | null {
  return key ? (keptPetSnapshot(key) ?? bundled(key)) : null;
}
export function keepPetSnapshot(key: string, uri: string) {
  kept.set(key, uri);
}
