import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import {
  checkCopiedMemoryTuple,
  convertCopiedMemoryTuple,
} from "../apps/server-identity/memory-copied-tuple";
function readManifest(path: string) {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 2 * 1024 * 1024 ||
      stat.mode & 0o077 ||
      stat.uid !== process.getuid?.()
    )
      throw Error("memory_copy_manifest_invalid");
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0,
      length: number;
    while (
      (length = readSync(fd, buffer, offset, buffer.length - offset, offset))
    ) {
      offset += length;
      if (offset > stat.size) throw Error("memory_copy_manifest_invalid");
    }
    const after = fstatSync(fd);
    if (
      offset !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw Error("memory_copy_manifest_invalid");
    return JSON.parse(buffer.subarray(0, offset).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}
// Explicit disposable snapshot only. Never loads a profile, starts a server or contacts a provider.
async function main() {
  try {
    const [action, flag, file, ...rest] = process.argv.slice(2);
    if (
      flag !== "--disposable-copy-manifest" ||
      !file ||
      !["check", "migrate", "reverse"].includes(action ?? "")
    )
      throw Error("memory_copy_arguments");
    const input = {
      manifest: readManifest(file),
      sourceIsDisposableCopy: true as const,
    };
    const result =
      action === "check" && rest.length === 0
        ? await checkCopiedMemoryTuple(input)
        : (action === "migrate" || action === "reverse") &&
            rest.length === 2 &&
            rest[0] === "--output"
          ? await convertCopiedMemoryTuple(input, rest[1]!, action)
          : (() => {
              throw Error("memory_copy_arguments");
            })();
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(
      JSON.stringify({
        profile: "niaro-memory-copied-tuple/1",
        status: "invalid",
        code: error instanceof Error ? error.message : "memory_copy_failed",
      }),
    );
    process.exitCode = 1;
  }
}
void main();
