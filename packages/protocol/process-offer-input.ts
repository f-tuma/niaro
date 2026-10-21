import { meetingProcessValueFitsInput } from "./meeting-process-input";
import type { ProcessInputValue } from "./process-start";
import type { ProcessData } from "./service-processes";

/** Only suggested values that fit a declared top-level input field survive;
 * everything else is left for the person to fill in. */
export function processOfferInitialInput(
  input: Record<string, unknown>,
  schema: ProcessData,
): Record<string, ProcessInputValue> {
  const values: Record<string, ProcessInputValue> = {};
  for (const [field, value] of Object.entries(input))
    if (meetingProcessValueFitsInput(field, value, schema))
      // Defined, not assigned: a "__proto__" key stays a plain field.
      Object.defineProperty(values, field, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  return values;
}
