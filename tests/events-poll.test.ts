import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureStorage } from "../apps/fixture-server/storage";
import { scopeFor } from "../packages/test-fixtures";
import { messageCommand } from "../packages/client-core/commands";

test("an events poll at the cursor reads the same as a full load, and a poll behind it the same events", () => {
  const directory = mkdtempSync(join(tmpdir(), "niaro-poll-"));
  const scope = scopeFor();
  const store = new FixtureStorage(
    directory,
    scope.serverId,
    () => 1_800_000_000_000,
  );
  try {
    store.execute(scope, messageCommand("Choose Peter", "en", "start"));
    const snapshot = store.snapshot(scope);
    const cursor = snapshot.cursor;
    expect(cursor).toBeGreaterThan(0);
    expect(store.poll(scope, cursor)).toEqual({
      conversations: snapshot.conversations.length,
      saved: store.events(scope, cursor),
      workItems: [],
    });
    const behind = store.poll(scope, cursor - 1);
    expect(behind.saved).toEqual(store.events(scope, cursor - 1));
    expect(behind.saved?.events).toHaveLength(1);
    expect(behind.workItems).toEqual(snapshot.workItems);
    expect(store.poll(scope, cursor + 1).saved).toBeNull();
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
