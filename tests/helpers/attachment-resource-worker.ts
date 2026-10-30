/** Synthetic opt-in resource harness; never imported by application code. */
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mobileIntegratedHttpFixture } from "./process-mobile-integrated-http";
let fixture:
  | Awaited<ReturnType<typeof mobileIntegratedHttpFixture>>
  | undefined;
let peak = process.memoryUsage(),
  spoolPeak = 0;
const timer = setInterval(() => {
  const current = process.memoryUsage();
  for (const key of Object.keys(peak) as (keyof typeof peak)[])
    peak[key] = Math.max(peak[key], current[key]);
  if (fixture) {
    const spool = join(fixture.root, "workflow", "attachment-spool");
    if (existsSync(spool))
      spoolPeak = Math.max(
        spoolPeak,
        readdirSync(spool).reduce(
          (sum, name) => sum + statSync(join(spool, name)).size,
          0,
        ),
      );
  }
}, 2);
process.on(
  "message",
  async (raw: { id: number; method: string; env?: Record<string, string> }) => {
    try {
      let value: unknown;
      if (raw.method === "start") {
        for (const key of Object.keys(process.env))
          if (key.startsWith("NIARO_S3_")) delete process.env[key];
        Object.assign(process.env, raw.env, {
          NIARO_ATTACHMENTS_ENABLED: "true",
        });
        fixture = await mobileIntegratedHttpFixture();
        const setup = await fixture.configure({ questions: 0, writes: 0 });
        value = {
          ...setup,
          processCommand: await fixture.prepare(
            setup.credential,
            setup.artifact,
          ),
        };
        peak = process.memoryUsage();
      } else if (raw.method === "revoke") {
        await fixture!.revokeDevice();
        value = true;
      } else if (raw.method === "stats")
        value = {
          peak,
          current: process.memoryUsage(),
          spoolPeak,
          modelCalls: fixture!.modelCount(),
          businessCalls: fixture!.businessCount(),
        };
      else if (raw.method === "close") {
        clearInterval(timer);
        await fixture?.close();
        process.send?.({ id: raw.id, value: true }, () => process.exit(0));
        return;
      } else throw Error("unknown fixture method");
      process.send?.({ id: raw.id, value });
    } catch (error) {
      process.send?.({
        id: raw.id,
        error: error instanceof Error ? error.message : "fixture failure",
      });
    }
  },
);
