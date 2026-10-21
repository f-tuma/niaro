import { pipelineHttpFixture } from "./process-pipeline-http";

// SQLite/Mastra only enter this Node child. Expo/Jest use test-only IPC control
// and the public paired HTTP transport; no fixture control is exposed via HTTP.
let fixture: Awaited<ReturnType<typeof pipelineHttpFixture>> | undefined;
process.on("message", async (raw: unknown) => {
  const message = raw as { id: number; method: string; args: unknown[] };
  try {
    let value: unknown;
    if (message.method === "init") {
      if (fixture) throw Error("TEST fixture is already initialized");
      fixture = await pipelineHttpFixture(
        message.args[0] as Parameters<typeof pipelineHttpFixture>[0],
      );
      value = { origin: fixture.origin };
    } else {
      if (!fixture) throw Error("TEST fixture is not initialized");
      const methods = {
        setupOnly: fixture.setupOnly,
        completePipeline: fixture.completePipeline,
        qualifyMobileDraft: fixture.qualifyMobileDraft,
        qualifyMobileServiceDraft: fixture.qualifyMobileServiceDraft,
        qualificationSuite: fixture.qualificationSuite,
        credential: fixture.credential,
        issuePairing: fixture.issuePairing,
        inspect: fixture.inspect,
        runtimeScenario: fixture.runtimeScenario,
        loops: fixture.loops,
        drift: fixture.drift,
        restart: fixture.restart,
        close: fixture.close,
      };
      if (!Object.hasOwn(methods, message.method))
        throw Error("TEST unsupported fixture operation");
      const operation = methods[message.method as keyof typeof methods] as (
        ...args: unknown[]
      ) => unknown;
      value = await operation(...message.args);
    }
    process.send?.({ id: message.id, value });
    if (message.method === "close") {
      fixture = undefined;
      process.disconnect();
    }
  } catch (error) {
    process.send?.({
      id: message.id,
      error: error instanceof Error ? error.message : "TEST fixture failed",
    });
  }
});
process.on("disconnect", () => {
  if (fixture) void fixture.close().finally(() => process.exit());
  else process.exit();
});
