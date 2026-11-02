import { setStringAsync } from "expo-clipboard";

/** Puts text on the system clipboard; false when the platform refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    return await setStringAsync(text);
  } catch {
    return false;
  }
}
