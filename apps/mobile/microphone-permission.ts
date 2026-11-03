/**
 * Microphone access, remembered once granted: for this app run in memory and
 * across launches as a hint, so a tap on the microphone starts capture at once
 * instead of asking the system first. A recorder that then fails, or a return
 * from the background (the system settings), checks again; a revoked access is
 * forgotten and the next tap asks as on first use.
 *
 * This module holds only the memory. The device check (`expo-audio`) is
 * registered by the native capture, so screens can read the memory anywhere.
 */
type HintStore = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};
const HINT = "niaro.microphone-granted/1";
let granted = false;
let hints: HintStore | null = null;
let check: (() => Promise<boolean>) | null = null;

const remember = (value: boolean) => {
  if (granted === value) return;
  granted = value;
  void hints?.setItem(HINT, value ? "granted" : "unknown").catch(() => {});
};

/** Access is known to be granted: capture may start without asking. */
export const microphoneGranted = () => granted;

/** Notes access the system just granted (a permission check or request). */
export function microphoneAllowed() {
  remember(true);
}

/** Reads the hint an earlier launch left, so a cold start is fast too. */
export async function loadMicrophoneHint(store: HintStore) {
  hints = store;
  try {
    if ((await store.getItem(HINT)) === "granted") granted = true;
  } catch {
    // Without the hint the first tap checks, as on first use.
  }
}

/** The device's own check, asking nothing; set by the native capture. */
export function setMicrophoneCheck(next: () => Promise<boolean>) {
  check = next;
}

/**
 * Checks without asking whether access still holds, after a recorder failed or
 * the app came back from the background. A revoked access is forgotten.
 */
export async function recheckMicrophone() {
  if (!check) return granted;
  try {
    const current = await check();
    remember(current);
    return current;
  } catch {
    remember(false);
    return false;
  }
}

/** Tests start every case from a first use. */
export function resetMicrophoneMemory() {
  granted = false;
  hints = null;
}
