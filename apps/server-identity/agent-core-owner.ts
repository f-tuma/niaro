/**
 * One Pi agent core per catalog controller, like the native runtime's owner:
 * the identity server opens it at start (`IdentityService.openAgentCore`),
 * and code that holds only a controller (process runs, tests) gets the same
 * one. Its file sits beside the identity database (`identity.sqlite.pi.sqlite`);
 * an in-memory identity database gets an in-memory core.
 */
import { fileURLToPath } from "node:url";
import type { PiAgentCore, PiAgentCoreOptions } from "@niaro/server-agent/pi";
import { operatorLog } from "../fixture-server/operator-log";
import type { IntegrationTransport } from "../server-integrations/transport";
import { agentCoreModelHost, type AgentCoreCatalog } from "./agent-core";

type Owner = {
  store: AgentCoreCatalog & { nativeStorageUrl: string };
  transport: IntegrationTransport;
};
const cores = new WeakMap<object, Promise<PiAgentCore>>();

/** The agent core file of an identity database, from its native store URL. */
export function agentCoreFile(nativeStorageUrl: string) {
  if (!nativeStorageUrl.startsWith("file:")) return undefined;
  return fileURLToPath(nativeStorageUrl).replace(
    /\.mastra\.sqlite$/,
    ".pi.sqlite",
  );
}

function localQueue() {
  let pending: Promise<unknown> = Promise.resolve();
  return <T>(run: () => Promise<T>) => {
    const task = pending.then(run);
    pending = task.catch(() => undefined);
    return task;
  };
}

/** The controller's agent core, opened on first use. */
export function agentCoreFor(
  controller: Owner,
  options: {
    serial?: <T>(run: () => Promise<T>) => Promise<T>;
    open?: Partial<PiAgentCoreOptions>;
  } = {},
) {
  let core = cores.get(controller);
  if (!core) {
    core = import("@niaro/server-agent/pi").then(({ PiAgentCore }) =>
      PiAgentCore.open({
        file: agentCoreFile(controller.store.nativeStorageUrl),
        host: agentCoreModelHost({
          catalog: controller.store,
          transport: controller.transport,
          serial: options.serial ?? localQueue(),
        }),
        // Kinds and error names only; never content or keys.
        onReport: (report) =>
          operatorLog(
            "agent_core",
            {
              kind: report.kind,
              error:
                report.error instanceof Error
                  ? report.error.name.slice(0, 60)
                  : "unknown",
            },
            "warn",
          ),
        ...options.open,
      }),
    );
    cores.set(controller, core);
    core.catch(() => {
      if (cores.get(controller) === core) cores.delete(controller);
    });
  }
  return core;
}

/** Close the controller's agent core, if it was opened. */
export async function closeAgentCore(controller: object) {
  const core = cores.get(controller);
  if (!core) return;
  cores.delete(controller);
  await (await core.catch(() => undefined))?.close();
}
