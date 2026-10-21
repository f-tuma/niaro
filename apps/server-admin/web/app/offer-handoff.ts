import type { ProcessOfferResult } from "../../../../packages/protocol/process-offer";

/**
 * A process the assistant offered in chat, handed to the Processes page once.
 * Kept in memory only: a reload starts with an ordinary process choice.
 */
let pending: ProcessOfferResult | null = null;
export function handOffProcessOffer(offer: ProcessOfferResult) {
  pending = offer;
}
export function takeProcessOffer() {
  const offer = pending;
  pending = null;
  return offer;
}
