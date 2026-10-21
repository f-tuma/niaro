import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, signal } from "./service-process-runtime";
import { processAgent, callProcessTool } from "./service-process-agent";

async function main() {
  const directory = process.argv[2]!;
  const stage = process.argv[3]!;
  const h = fixture(join(directory, "identity.sqlite"));
  const id = h.activate(processAgent(h, "conversation"));
  writeFileSync(
    join(directory, "run.json"),
    JSON.stringify({ processId: id, ids: h.ids }),
  );
  let responded = false;
  const serial = h.context.serial;
  h.context.serial = async (run) => {
    // Cut between the external synthetic response and the authoritative local commit.
    if (responded) process.kill(process.pid, "SIGKILL");
    return serial(run);
  };
  if (stage === "model")
    h.onModelResponse(() => {
      responded = true;
    });
  else h.onModel(() => callProcessTool());
  try {
    const result = await h.runtime.start(
      id,
      "TEST-crash",
      { name: "TEST-input" },
      signal(),
    );
    if (stage === "write") {
      if (!result.approval) throw Error("TEST expected native approval");
      h.onServiceResponse(() => {
        responded = true;
      });
      await h.runtime.resume(
        "TEST-crash",
        { ...result.approval, approved: true },
        signal(),
      );
    }
    throw Error("TEST expected SIGKILL at local commit");
  } catch (error) {
    process.stderr.write(String(error));
    process.exitCode = 1;
  } finally {
    await h.close();
  }
}
void main().catch((error: unknown) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
