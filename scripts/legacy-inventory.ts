import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import {
  inventoryLegacyTuple,
  LegacyInventoryFailure,
} from "../apps/server-identity/legacy-run-inventory";

// An explicit private snapshot manifest; no profile/env/runtime bootstrap.
try {
  const [flag, file, ...extra] = process.argv.slice(2);
  if (flag !== "--manifest" || !file || extra.length)
    throw new LegacyInventoryFailure("manifest_invalid");
  let value: unknown;
  try {
    const fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
        throw new LegacyInventoryFailure("manifest_invalid");
      const buffer = Buffer.alloc(stat.size + 1);
      let offset = 0,
        length: number;
      while (
        (length = readSync(fd, buffer, offset, buffer.length - offset, offset))
      ) {
        offset += length;
        if (offset > stat.size)
          throw new LegacyInventoryFailure("manifest_invalid");
      }
      if (offset !== stat.size)
        throw new LegacyInventoryFailure("manifest_invalid");
      const after = fstatSync(fd);
      if (
        after.size !== stat.size ||
        after.mode !== stat.mode ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs
      )
        throw new LegacyInventoryFailure("manifest_invalid");
      value = JSON.parse(buffer.subarray(0, offset).toString("utf8"));
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new LegacyInventoryFailure("manifest_invalid");
  }
  const report = inventoryLegacyTuple(value);
  console.log(JSON.stringify(report));
  process.exitCode = 2;
} catch (error) {
  console.log(
    JSON.stringify({
      profile: "niaro-legacy-inventory/4",
      status: "invalid",
      code:
        error instanceof LegacyInventoryFailure
          ? error.code
          : "inventory_failed",
    }),
  );
  process.exitCode = 1;
}
