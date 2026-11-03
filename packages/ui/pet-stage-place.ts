/** A view's place on screen, as measured. */
export type PetStageBox = {
  pageX: number;
  pageY: number;
  width: number;
  height: number;
};

/**
 * Where the stage draws its pet for a slot, as translations only (they apply on the UI thread in
 * the frame they are set; sizes would wait for a layout pass). The pet is clipped to the slot's
 * scrolling area by two clipping layers the stage's own size: the outer one starts at the area's
 * top-left corner, the inner one ends at its bottom-right corner, and what both let through is the
 * area. Inside them the pet keeps its own size and is scaled about its centre onto the slot.
 */
export function petPlacement(
  stage: PetStageBox,
  bounds: PetStageBox,
  slot: PetStageBox,
  size: number,
) {
  "worklet";
  const left = bounds.pageX - stage.pageX,
    top = bounds.pageY - stage.pageY,
    right = left + bounds.width,
    bottom = top + bounds.height;
  // The inner layer's origin, in the stage's coordinates.
  const innerX = right - stage.width,
    innerY = bottom - stage.height;
  return {
    outerX: left,
    outerY: top,
    innerX: innerX - left,
    innerY: innerY - top,
    petX: slot.pageX - stage.pageX + slot.width / 2 - size / 2 - innerX,
    petY: slot.pageY - stage.pageY + slot.height / 2 - size / 2 - innerY,
    scale: Math.min(slot.width, slot.height) / size,
  };
}
