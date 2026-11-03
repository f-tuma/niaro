import { tokens as t } from "../design-tokens";
import { PET_COUNTS, type PetAppearance, type PetState } from "./pet-motion";
import { petHash } from "./pet-hash";
import { PET_SHADER_SOURCE } from "./pet-shader";
import { savedPetSnapshots } from "./pet-snapshot-io";

/**
 * Stills of a pet's first live frame, shown the moment a pet mounts while its shader compiles.
 * That frame depends only on the look, the card behind it, rest or not, and the drawing size
 * (the clock starts at 2, nothing has touched it), so a still taken once looks exactly like the
 * live pet that replaces it. Busy states and reduced motion are not kept.
 *
 * A pet with no still of its own exact frame borrows the nearest one of the same body (shape,
 * colour and card): its ink or size may differ a little, and the cross-fade into the live pet
 * hides that (NIAR-277).
 */
export type PetSnapshot = number | string; // a bundled image, or a file or blob URI
export type PetStill = {
  source: PetSnapshot;
  /** The very frame the live pet starts on; otherwise a near one that wants a longer fade. */
  exact: boolean;
};

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
function parts(look: Omit<PetSnapshotLook, "reduced">) {
  const a = look.appearance;
  return [
    petShaderVersion(),
    a?.shape ?? "cookie",
    (a?.tint ?? DEFAULT_TINT).map((value) => value.toFixed(4)).join(","),
    (a?.counts ?? PET_COUNTS).join(","),
    look.background.toLowerCase(),
    look.state,
    String(Math.round(look.pixels)),
  ];
}
/** The cache key of a first frame, or null when that frame is not worth keeping. */
export function petSnapshotKey(look: PetSnapshotLook): string | null {
  if (look.reduced || (look.state !== "idle" && look.state !== "resting"))
    return null;
  return parts(look).join("|");
}
// The body a still shows: renderer, shape, colour and card, without ink, state or size.
const familyOf = (part: string[]) =>
  petHash([part[0], part[1], part[2], part[4]].join("|"));
/** `pet-<body>-<state>-<frame>.png`: a pet without its own frame finds its body's by name. */
export function petSnapshotFile(key: string) {
  const part = key.split("|");
  return `pet-${familyOf(part)}-${part[5]}-${petHash(key)}.png`;
}

// The pet before pairing and before the profile arrives: the default look on the app's card,
// rendered once by scripts/render-pet-still.ts from this shader. A changed shader no longer
// matches its version, so it is not shown until it is rendered again (a test says so).
export const BUNDLED_STILL_VERSION = "1xvzs73";
function bundled(part: string[]): PetStill | null {
  if (BUNDLED_STILL_VERSION !== petShaderVersion()) return null;
  const base = parts({
    background: t.color.background,
    state: "idle",
    pixels: 0,
  });
  if (familyOf(part) !== familyOf(base)) return null;
  return {
    source: require("./assets/pet-still.png") as number,
    exact: part[3] === base[3] && part[5] === "idle",
  };
}

// Newest first: what this device saved (the cache folder, read once), then this session's.
let saved: { name: string; uri: string }[] | undefined;
function savedStills() {
  return (saved ??= savedPetSnapshots());
}
/** A snapshot this device saved for exactly this key. */
export function keptPetSnapshot(key: string | null): string | null {
  if (!key) return null;
  const name = petSnapshotFile(key);
  return savedStills().find((still) => still.name === name)?.uri ?? null;
}
export function keepPetSnapshot(key: string, uri: string) {
  const name = petSnapshotFile(key);
  saved = [
    { name, uri },
    ...savedStills().filter((still) => still.name !== name),
  ];
}

/**
 * What to show for a pet until it draws, found without waiting: its own first frame, else the
 * same body in the same state, else the same body at all, else the bundled default pet.
 */
export function petStill(
  look: Omit<PetSnapshotLook, "reduced"> & { reduced?: boolean },
): PetStill | null {
  const key = petSnapshotKey({ reduced: false, ...look });
  const own = keptPetSnapshot(key);
  if (own) return { source: own, exact: true };
  const part = parts(look);
  const family = `pet-${familyOf(part)}-`;
  const stills = savedStills().filter((still) => still.name.startsWith(family));
  const near =
    stills.find((still) => still.name.startsWith(`${family}${part[5]}-`)) ??
    stills.find((still) => !still.name.startsWith(`${family}resting-`)) ??
    stills[0];
  if (near) return { source: near.uri, exact: false };
  const fallback = bundled(part);
  return fallback && { ...fallback, exact: fallback.exact && !!key };
}
