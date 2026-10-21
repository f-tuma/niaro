/** These probes measure server mechanics with scripted inference, not model quality. */
export type TrustRuntimeProfile = "mastra-1";
export type ProbeStatus = "passed" | "failed" | "gap";
export type ProbeResult = {
  id: string;
  description: string;
  status: ProbeStatus;
  evidence?: unknown;
};
export interface TrustProbe {
  signal: AbortSignal;
  defer(cleanup: () => void | Promise<void>): void;
  check(
    id: string,
    description: string,
    assertion: () => void | Promise<void>,
  ): Promise<void>;
  observe(key: string, value: unknown): void;
  gap(id: string, description: string, evidence: unknown): void;
}
export type TrustScenario = {
  id: string;
  title: string;
  run(probe: TrustProbe): Promise<void>;
};
