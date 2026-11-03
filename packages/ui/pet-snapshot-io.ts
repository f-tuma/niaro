import type { ExpoWebGLRenderingContext } from "expo-gl";
import { supportedGLView } from "./gl-surface";

// Native: expo-gl runs GL on its own thread. Snapshots go to the app cache, so a cold start
// still finds the pet's last first frame; the OS may clear them, which only costs one compile.
type Files = typeof import("expo-file-system");
let files: Files | null | undefined;
function fileSystem() {
  if (files === undefined)
    try {
      // Loaded on first use: the shared UI must not need the module where it is absent.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      files = require("expo-file-system") as Files;
    } catch {
      files = null;
    }
  return files;
}
const FOLDER = "pet-snapshots";
const KEEP = 24;

function remove(uri: string | null | undefined) {
  const fs = fileSystem();
  if (!fs || !uri) return;
  try {
    const file = new fs.File(uri);
    if (file.exists) file.delete();
  } catch {
    /* A cache file that cannot be removed is left to the OS. */
  }
}

/**
 * Resolves once the GL thread has run everything queued before it, such as the pet's compile,
 * without blocking JS. A one-pixel snapshot is the only expo-gl call that settles a promise on
 * that thread after the queued work; its file is removed at once.
 */
export async function glSettled(
  gl: ExpoWebGLRenderingContext,
  _renderer?: { compiling(): boolean },
) {
  const GLView = supportedGLView();
  if (!GLView) return;
  try {
    const shot = await GLView.takeSnapshotAsync(gl, {
      rect: { x: 0, y: 0, width: 1, height: 1 },
      format: "png",
    });
    remove(typeof shot.uri === "string" ? shot.uri : shot.localUri);
  } catch {
    /* The caller then simply waits for the compile, as before. */
  }
}

function savedFiles(fs: Files) {
  const folder = new fs.Directory(fs.Paths.cache, FOLDER);
  if (!folder.exists) return [];
  return folder
    .list()
    .filter(
      (entry): entry is InstanceType<Files["File"]> => entry instanceof fs.File,
    )
    .sort((a, b) => (b.modificationTime ?? 0) - (a.modificationTime ?? 0));
}

/** Every kept snapshot in the cache, newest first (read once, synchronously, at the first pet). */
export function savedPetSnapshots(): { name: string; uri: string }[] {
  const fs = fileSystem();
  if (!fs) return [];
  try {
    return savedFiles(fs).map((file) => ({ name: file.name, uri: file.uri }));
  } catch {
    return [];
  }
}

/** Whether this build can save the frame it drew (expo-gl with snapshots and a file system). */
export function canSavePetSnapshot() {
  return (
    typeof supportedGLView()?.takeSnapshotAsync === "function" && !!fileSystem()
  );
}

/** Saves the frame just drawn under this name; resolves to its uri, or null. */
export async function savePetSnapshot(
  gl: ExpoWebGLRenderingContext,
  name: string,
): Promise<string | null> {
  const GLView = supportedGLView();
  const fs = fileSystem();
  if (!GLView || !fs) return null;
  const shot = await GLView.takeSnapshotAsync(gl, { format: "png" });
  const source = typeof shot.uri === "string" ? shot.uri : shot.localUri;
  if (!source) return null;
  try {
    const folder = new fs.Directory(fs.Paths.cache, FOLDER);
    folder.create({ intermediates: true, idempotent: true });
    const target = new fs.File(folder, name);
    await new fs.File(source).move(target, { overwrite: true });
    // A few looks, backgrounds and sizes at most: the oldest go first.
    for (const old of savedFiles(fs).slice(KEEP)) remove(old.uri);
    return target.uri;
  } catch {
    remove(source);
    return null;
  }
}
