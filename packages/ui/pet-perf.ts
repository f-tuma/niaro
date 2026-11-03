/**
 * Development-only timing of each pet's start, one `[pet-perf]` line per pet, readable from a
 * phone through the Metro terminal or `adb logcat -s ReactNativeJS`. Release builds and tests
 * print nothing; the count of GL contexts runs for the whole app session.
 */
let contexts = 0;
const enabled =
  typeof __DEV__ !== "undefined" && __DEV__ && process.env.NODE_ENV !== "test";

export type PetPerf = {
  /** A step, timed from the pet's mount. */
  mark(step: string, note?: string): void;
  /** A new GL context for this pet (counted for the session). */
  context(): void;
  /** Prints the line once. */
  done(note: string): void;
};

/** One stage line (development only): where the app's one pet went. */
export function petPerfNote(note: string) {
  if (enabled)
    console.log(`[pet-perf] ${note}; GL contexts this session ${contexts}`);
}

export function petPerf(label: string): PetPerf | null {
  if (!enabled) return null;
  const start = performance.now();
  const steps: string[] = [];
  let printed = false;
  return {
    mark(step, note) {
      steps.push(
        `${step} ${Math.round(performance.now() - start)}ms${note ? ` (${note})` : ""}`,
      );
    },
    context() {
      contexts++;
      this.mark("context");
    },
    done(note) {
      if (printed) return;
      printed = true;
      console.log(
        `[pet-perf] ${label}: ${steps.join(", ")}; ${note}; GL contexts this session ${contexts}`,
      );
    },
  };
}
