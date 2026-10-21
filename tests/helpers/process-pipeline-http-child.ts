import { fork } from "node:child_process";
import { resolve } from "node:path";
import type {
  PipelineScenario,
  pipelineHttpFixture,
} from "./process-pipeline-http";

type Fixture = Awaited<ReturnType<typeof pipelineHttpFixture>>;
export type PipelineFixtureSetup = Awaited<ReturnType<Fixture["setupOnly"]>>;
export type PipelineFixtureComplete = Awaited<
  ReturnType<Fixture["completePipeline"]>
>;
export type PipelineFixtureMobileDraft = Awaited<
  ReturnType<Fixture["qualifyMobileDraft"]>
>;
export type PipelineFixtureInspection = Awaited<ReturnType<Fixture["inspect"]>>;

/** Test-only IPC control, never an HTTP fixture-admin endpoint or Expo import. */
export async function pipelineHttpChildFixture(
  options: {
    testAllowedOrigins?: string[];
    outputPadding?: boolean;
    workspaceOwned?: boolean;
    cwd?: string;
  } = {},
) {
  const cwd = options.cwd ?? process.cwd();
  const child = fork(
    resolve(cwd, "tests/helpers/process-pipeline-http-worker.ts"),
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
      const timeout = setTimeout(
        () => {
          pending.delete(id);
          reject(Error(`TEST HTTP child timed out (${method})`));
        },
        method === "completePipeline" ||
          method === "qualifyMobileDraft" ||
          method === "qualifyMobileServiceDraft"
          ? 150_000
          : 30_000,
      );
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
      outputPadding: options.outputPadding,
      workspaceOwned: options.workspaceOwned,
    });
    return {
      origin,
      setupOnly: () => rpc<PipelineFixtureSetup>("setupOnly"),
      completePipeline: () => rpc<PipelineFixtureComplete>("completePipeline"),
      qualifyMobileDraft: () =>
        rpc<PipelineFixtureMobileDraft>("qualifyMobileDraft"),
      qualifyMobileServiceDraft: () =>
        rpc<PipelineFixtureMobileDraft>("qualifyMobileServiceDraft"),
      qualificationSuite: () =>
        rpc<ReturnType<Fixture["qualificationSuite"]>>("qualificationSuite"),
      credential: (role: "owner" | "member" = "owner") =>
        rpc<Awaited<ReturnType<Fixture["credential"]>>>("credential", role),
      issuePairing: (role: "owner" | "member" = "owner") =>
        rpc<Awaited<ReturnType<Fixture["issuePairing"]>>>("issuePairing", role),
      inspect: () => rpc<PipelineFixtureInspection>("inspect"),
      runtimeScenario: (scenario: PipelineScenario) =>
        rpc<void>("runtimeScenario", scenario),
      loops: (id?: string) =>
        rpc<Awaited<ReturnType<Fixture["loops"]>>>("loops", id),
      drift: (kind: "service" | "model" | "permission") =>
        rpc<void>("drift", kind),
      restart: () => rpc<void>("restart"),
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
