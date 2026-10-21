import { mobileIntegratedHttpFixture } from "./process-mobile-integrated-http";

// This process alone imports SQLite/Mastra. Jest and Expo consumers use IPC and
// the same ordinary paired HTTP endpoints as ClientSession.
let fixture:
  | Awaited<ReturnType<typeof mobileIntegratedHttpFixture>>
  | undefined;
process.on("message", async (raw: unknown) => {
  const message = raw as { id: number; method: string; args: unknown[] };
  try {
    let value: unknown;
    if (message.method === "init") {
      if (fixture) throw Error("TEST fixture is already initialized");
      fixture = await mobileIntegratedHttpFixture(
        message.args[0] as Parameters<typeof mobileIntegratedHttpFixture>[0],
      );
      value = { origin: fixture.origin };
    } else {
      if (!fixture) throw Error("TEST fixture is not initialized");
      const methods = {
        configure: fixture.configure,
        enableDesignerProposal: fixture.enableDesignerProposal,
        seedDesignerPages: fixture.seedDesignerPages,
        serviceDraftIds: fixture.serviceDraftIds,
        seedMeeting: fixture.seedMeeting,
        moveMeetingOutsidePairedUserScope:
          fixture.moveMeetingOutsidePairedUserScope,
        inspect: fixture.inspect,
        issuePairing: fixture.issuePairing,
        hold: fixture.hold,
        release: fixture.release,
        restart: fixture.restart,
        revokeDevice: fixture.revokeDevice,
        disableService: fixture.disableService,
        disableAction: fixture.disableAction,
        disableModel: fixture.disableModel,
        disableMemory: fixture.disableMemory,
        revokeMembership: fixture.revokeMembership,
        exhaustBudget: fixture.exhaustBudget,
        loops: fixture.loops,
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
