// Offline production-store fixture. Never imported by the application.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommandSchema } from "../../packages/protocol";
import {
  nativeCatalogOwner,
  NativeRunUnsettledError,
} from "../../apps/server-identity/mastra-runtime";
import { createTrustHarness } from "../agent-trust/harness";

const directory = process.argv[2];
const mode = process.argv[3];
if (!directory || !["answer", "held"].includes(mode ?? ""))
  throw Error("TEST fatal crash fixture arguments invalid");
const sentinel = "TEST_PRIVATE_FATAL_CRASH_CREDENTIAL";
let armed = false;
function killAt(site: string): never {
  writeFileSync(
    join(directory!, "fatal-cut.json"),
    JSON.stringify({ mode, site }),
  );
  process.kill(process.pid, "SIGKILL");
  throw Error("TEST fatal crash fixture did not terminate");
}
const h = createTrustHarness({
  directory,
  cleanupDirectory: false,
  checkpoint: (stage, change) => {
    if (
      armed &&
      mode === "answer" &&
      change === "command" &&
      stage === "before_commit"
    )
      killAt("workflow-before-commit");
  },
});
h.db.exec("CREATE TABLE TEST_fatal_crash_call(kind TEXT NOT NULL)");
h.onBeforeActionDispatch(() => {
  h.db.prepare("INSERT INTO TEST_fatal_crash_call VALUES('action')").run();
});
h.onChat(() => {
  h.db.prepare("INSERT INTO TEST_fatal_crash_call VALUES('model')").run();
  if (mode === "held")
    return h.call("ask_user", { question: "TEST Which day?" });
  const result = h.call("find_service", {});
  result.tool_calls[0]!.function.arguments = '{"private":"' + sentinel + '"';
  return result;
});
const original = CommandSchema.parse({
  type: "message.send",
  commandId: "TEST-fatal-crash-outer-" + mode,
  idempotencyKey: "TEST-fatal-crash-idempotency-" + mode,
  conversationId: "conversation-1",
  text: "TEST complete this request",
  language: "cs",
  timeZone: "UTC",
});
async function main() {
  if (mode === "held") {
    const runtime = await nativeCatalogOwner(h.controller);
    const execute = runtime.execute;
    runtime.execute = async (input) => {
      const output = await execute(input);
      if (!output.suspended)
        throw Error("TEST fixture must reach actual suspension");
      throw Error(sentinel);
    };
    // Simulate losing suspension confirmation while the actual SDK checkpoint
    // remains durable. Reopened proof must find it without this test override.
    runtime.proveSuspended = async () => false;
  }
  armed = true;
  try {
    await h.execute(original);
    throw Error("TEST expected fatal crash cut was not reached");
  } catch (error) {
    if (mode !== "held" || !(error instanceof NativeRunUnsettledError))
      throw error;
    if (!h.commandState().terminalCandidate || h.commandState().answer)
      throw Error("TEST unproved fatal candidate was not durable");
    killAt("candidate-with-live-native-checkpoint");
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
