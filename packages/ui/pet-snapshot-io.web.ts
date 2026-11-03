import type { ExpoWebGLRenderingContext } from "expo-gl";
import { supportedGLView } from "./gl-surface";

// Web: WebGL runs on the page's own thread. Snapshots live as blob URLs for the session.

/**
 * Resolves once the browser has compiled the pet, polling once a frame where the driver can say
 * without waiting (KHR_parallel_shader_compile); otherwise on the next frame, after which the
 * first query waits for the compile once, as before.
 */
export function glSettled(
  _gl: ExpoWebGLRenderingContext,
  renderer?: { compiling(): boolean },
) {
  return new Promise<void>((resolve) => {
    const started = performance.now();
    const check = () => {
      let busy = false;
      try {
        busy = !!renderer?.compiling() && performance.now() - started < 10000;
      } catch {
        busy = false;
      }
      if (busy) requestAnimationFrame(check);
      else resolve();
    };
    requestAnimationFrame(check);
  });
}

export function savedPetSnapshots(): { name: string; uri: string }[] {
  return [];
}

export function canSavePetSnapshot() {
  return (
    typeof supportedGLView()?.takeSnapshotAsync === "function" &&
    typeof URL !== "undefined" &&
    !!URL.createObjectURL
  );
}

/** Saves the frame just drawn (read in the same task, before the canvas is composited). */
export async function savePetSnapshot(
  gl: ExpoWebGLRenderingContext,
  _name: string,
): Promise<string | null> {
  const GLView = supportedGLView();
  if (!GLView || typeof URL === "undefined" || !URL.createObjectURL)
    return null;
  const shot = await GLView.takeSnapshotAsync(gl);
  return shot.uri instanceof Blob ? URL.createObjectURL(shot.uri) : null;
}
