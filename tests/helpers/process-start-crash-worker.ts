// Isolated synthetic process-crash boundary. Never loaded by application code.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFixture } from "./process-start";
import { admin, scope } from "./service-process-runtime";

const root = process.argv[2]!;
const mode = process.argv[3]!;
const tables: Record<string, string> = {
  pin: "agent_service_process_run",
  seed: "agent_service_turn",
  receipt: "agent_process_start_command",
};
if (!root || (!Object.hasOwn(tables, mode) && mode !== "committed"))
  throw Error("TEST invalid cut");
const h = startFixture(join(root, "identity.sqlite"));
const state = h.setup();
writeFileSync(
  join(root, "manifest.json"),
  JSON.stringify({ ...state, ids: h.ids }),
);
const kill = () => {
  const counts = [
    "agent_process_start_command",
    "agent_service_process_run",
    "agent_service_turn",
  ].map((table) =>
    Number(h.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n),
  );
  writeFileSync(
    join(root, "cut.json"),
    JSON.stringify({
      mode,
      counts,
      effects: h.counts(),
      models: h.models(),
      journalMode: h.db.prepare("PRAGMA journal_mode").get()!.journal_mode,
      synchronous: h.db.prepare("PRAGMA synchronous").get()!.synchronous,
    }),
  );
  process.kill(process.pid, "SIGKILL");
  throw Error("TEST kill did not terminate");
};
if (mode !== "committed") {
  h.db.function("test_start_cut", kill);
  h.db.exec(`CREATE TEMP TRIGGER test_start_cut AFTER INSERT ON ${tables[mode]}
    BEGIN SELECT test_start_cut(); END;`);
}
const receipt = h.starts.admit(
  admin,
  scope,
  state.intent.intentId,
  state.command,
  () => {},
);
if (receipt.status !== "admitted") throw Error("TEST expected admitted cut");
writeFileSync(join(root, "receipt.json"), JSON.stringify(receipt));
kill();
