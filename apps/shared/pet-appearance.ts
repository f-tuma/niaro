import { PET_PALETTE as protocolPalette } from "../../packages/protocol/work-pet";
import type { PetProfile } from "../../packages/protocol/work-pet";
import type { PetAppearance } from "../../packages/ui/pet-motion";
/** Original approved palette; retain original float optics rather than round-tripping hex. */
const colourNames = [
  "Lavender",
  "Mint",
  "Peach",
  "Sky",
  "Lemon",
  "Rose",
  "Sage",
  "Mist",
];
export const PET_PALETTE = protocolPalette.map((colour, index) => ({
  ...colour,
  en: colourNames[index]!,
  cs: colour.name,
}));
export function profilePetAppearance(profile: PetProfile): PetAppearance {
  return {
    shape:
      profile.settings.shape === "auto"
        ? profile.automaticShape
        : profile.settings.shape,
    tint:
      PET_PALETTE.find((value) => value.hex === profile.settings.colour)?.rgb ??
      protocolPalette[0].rgb,
    counts: ["work", "projects", "tools", "people", "style", "rhythm"].map(
      (section) =>
        12 *
        (profile.look.find((value) => value.section === section)?.weight ??
          0) **
          2,
    ),
  };
}
