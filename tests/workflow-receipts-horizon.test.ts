import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  FixtureStorage,
  RECENT_RECEIPTS,
} from "../apps/fixture-server/storage";
import { CommandSchema } from "../packages/protocol";

const scope = {
  connectionId: "fixture-a",
  serverId: "fixture-0123456789abcdef01234567",
  userId: "alice",
  workspaceId: "a",
};
const command = (value: object) => CommandSchema.parse(value);
const rename = (n: number, title = `Chat ${n}`) =>
  command({
    type: "conversation.rename",
    conversationId: "chat-TEST-horizon",
    commandId: `TEST-rename-${n}`,
    idempotencyKey: `TEST-key-${n}`,
    title,
  });

test("a scope takes more commands than the engine's receipt window, and a retry from before the window still replays its receipt", () => {
  const directory = mkdtempSync(join(tmpdir(), "TEST-receipts-horizon-"));
  const storage = new FixtureStorage(directory, scope.serverId);
  try {
    storage.execute(
      scope,
      command({
        type: "conversation.create",
        conversationId: "chat-TEST-horizon",
        commandId: "TEST-create",
        idempotencyKey: "TEST-create",
      }),
    );
    // Well past the window (and past the old 2,000-receipt stop).
    const total = Math.max(RECENT_RECEIPTS * 2 + 5, 2_050);
    for (let n = 0; n < total; n++)
      expect(storage.execute(scope, rename(n)).code).toBe("accepted");
    const db = new DatabaseSync(join(directory, "workflow.sqlite"), {
      readOnly: true,
    });
    const stored = db.prepare("SELECT COUNT(*) AS n FROM receipts").get() as {
      n: number;
    };
    db.close();
    expect(stored.n).toBe(total + 1);

    // The same press from long ago returns its receipt, not a new effect.
    const replay = storage.execute(scope, rename(3));
    expect(replay.status).toBe("accepted");
    expect(replay.code).toBe("accepted");
    // Its id with another payload is refused, however old the id is.
    const changed = storage.execute(scope, rename(3, "Another title"));
    expect(changed.code).toBe("idempotency_conflict");
    // The same key under a new id is refused too.
    const reusedKey = storage.execute(
      scope,
      command({
        type: "conversation.rename",
        conversationId: "chat-TEST-horizon",
        commandId: "TEST-rename-fresh",
        idempotencyKey: "TEST-key-3",
        title: "Chat 3",
      }),
    );
    expect(reusedKey.code).toBe("idempotency_conflict");
    // A genuinely new command still goes through.
    expect(storage.execute(scope, rename(total + 10)).code).toBe("accepted");
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
