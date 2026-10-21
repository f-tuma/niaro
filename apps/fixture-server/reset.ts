import { existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { acquireServerLock } from "./storage";
const directory = resolve(process.env.FIXTURE_DATA_DIR ?? ".fixture");
if (existsSync(directory)) {
  const archive = `${directory}.backup-${Date.now()}`;
  const release = acquireServerLock(directory);
  try {
    renameSync(directory, archive);
  } finally {
    release();
  }
  console.log(
    `Fixture archived to ${archive}. Restart the stopped server for a fresh scenario.`,
  );
} else console.log("No saved fixture to reset.");
