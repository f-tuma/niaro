import { fork } from "node:child_process";
import { resolve } from "node:path";
import type {
  MobileFixtureHold,
  MobileProcessScenario,
  mobileIntegratedHttpFixture,
} from "./process-mobile-integrated-http";

type Fixture = Awaited<ReturnType<typeof mobileIntegratedHttpFixture>>;
export type MobileFixtureSetup = Awaited<ReturnType<Fixture["configure"]>>;
export type MobileFixtureInspection = ReturnType<Fixture["inspect"]>;

/** Test-only IPC control, never an HTTP fixture-admin endpoint or Expo import. */
export async function mobileHttpChildFixture(
  options: {
    testAllowedOrigins?: string[];
    testSavedMemory?: boolean;
    cwd?: string;
  } = {},
) {
  const cwd = options.cwd ?? process.cwd();
  const child = fork(
    resolve(cwd, "tests/helpers/process-mobile-http-worker.ts"),
    [],
    {
      cwd,
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let next = 0;
  let closed = false;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  // Consume diagnostics without printing synthetic access tokens/setup payloads.
  child.stdout?.resume();
  child.stderr?.resume();
  const fail = (error: Error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", (code) => {
    if (!closed) fail(Error(`TEST HTTP child exited (${code})`));
  });
  child.on("message", (raw: unknown) => {
    const reply = raw as { id: number; value?: unknown; error?: string };
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    clearTimeout(request.timeout);
    if (reply.error) request.reject(Error(reply.error));
    else request.resolve(reply.value);
  });
  const rpc = <T>(method: string, ...args: unknown[]) =>
    new Promise<T>((resolve, reject) => {
      const id = ++next;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(Error(`TEST HTTP child timed out (${method})`));
      }, 30_000);
      pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      child.send({ id, method, args }, (error) => {
        if (error) {
          clearTimeout(timeout);
          pending.delete(id);
          reject(error);
        }
      });
    });
  try {
    const { origin } = await rpc<{ origin: string }>("init", {
      testAllowedOrigins: options.testAllowedOrigins,
      testSavedMemory: options.testSavedMemory,
    });
    return {
      origin,
      configure: (
        scenario: MobileProcessScenario = {},
        role: "owner" | "member" = "owner",
      ) => rpc<MobileFixtureSetup>("configure", scenario, role),
      enableDesignerProposal: () => rpc<void>("enableDesignerProposal"),
      seedDesignerPages: (serviceId: string, count?: number) =>
        rpc<{
          existingDraftId: string;
          foreignServiceId: string;
          foreignSessionId: string;
          foreignActorSessionId: string;
          pageSessionIds: string[];
          pageDraftIds: string[];
        }>("seedDesignerPages", serviceId, count),
      serviceDraftIds: (serviceId: string) =>
        rpc<string[]>("serviceDraftIds", serviceId),
      seedMeeting: () =>
        rpc<{
          meetingId: string;
          title: string;
          recordDigest: string;
          taskId: string;
        }>("seedMeeting"),
      moveMeetingOutsidePairedUserScope: (meetingId: string) =>
        rpc<void>("moveMeetingOutsidePairedUserScope", meetingId),
      inspect: () => rpc<MobileFixtureInspection>("inspect"),
      issuePairing: () =>
        rpc<{ address: string; code: string }>("issuePairing"),
      hold: (stage: MobileFixtureHold) => rpc<void>("hold", stage),
      release: (stage?: MobileFixtureHold) => rpc<void>("release", stage),
      restart: () => rpc<void>("restart"),
      revokeDevice: (accessToken?: string) =>
        rpc<void>("revokeDevice", accessToken),
      disableService: () => rpc<void>("disableService"),
      disableAction: () => rpc<void>("disableAction"),
      disableModel: () => rpc<void>("disableModel"),
      disableMemory: () => rpc<void>("disableMemory"),
      revokeMembership: () => rpc<void>("revokeMembership"),
      exhaustBudget: () => rpc<void>("exhaustBudget"),
      loops: (
        id?: string,
        role: "owner" | "admin" | "member" | "anonymous" = "owner",
      ) => rpc<Awaited<ReturnType<Fixture["loops"]>>>("loops", id, role),
      close: async () => {
        if (closed) return;
        await rpc<void>("close");
        closed = true;
      },
    };
  } catch (error) {
    closed = true;
    child.kill();
    throw error;
  }
}
