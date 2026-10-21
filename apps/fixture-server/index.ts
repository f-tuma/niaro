import { resolve } from "node:path";
import { createFixtureServer } from "./http";
import { loadCalendarConfig } from "./calendar";
import { LocalWhisper } from "./voice";
import { configuredGeminiTranscriber } from "./voice-openrouter";
import { configuredModel } from "./openrouter";
import { loadTwentyConfig, TwentyTestDirectory } from "./twenty";
const host = process.env.FIXTURE_ALLOW_LAN === "1" ? "0.0.0.0" : "127.0.0.1";
const port = Number(process.env.FIXTURE_PORT ?? 8787);
const voiceDirectory = process.env.FIXTURE_VOICE_DIR;
const voiceEngine = process.env.FIXTURE_VOICE_ENGINE ?? "whisper.cpp";
if (!["whisper.cpp", "openrouter"].includes(voiceEngine))
  throw new Error("Unsupported voice engine");
if (
  voiceEngine === "openrouter" &&
  (!voiceDirectory || !process.env.FIXTURE_MODEL_CONFIG)
)
  throw new Error(
    "Cloud voice requires the local speech filter and private OpenRouter configuration",
  );
const server = createFixtureServer(
  resolve(process.env.FIXTURE_DATA_DIR ?? ".fixture"),
  process.env.FIXTURE_ALLOWED_ORIGINS?.split(","),
  {
    crm: process.env.FIXTURE_CRM_CONFIG
      ? new TwentyTestDirectory(
          loadTwentyConfig(resolve(process.env.FIXTURE_CRM_CONFIG)),
        )
      : undefined,
    model: process.env.FIXTURE_MODEL_CONFIG
      ? configuredModel(resolve(process.env.FIXTURE_MODEL_CONFIG))
      : undefined,
    transcriber: voiceDirectory
      ? voiceEngine === "openrouter"
        ? configuredGeminiTranscriber(
            resolve(process.env.FIXTURE_MODEL_CONFIG!),
            resolve(voiceDirectory),
          )
        : new LocalWhisper(resolve(voiceDirectory))
      : undefined,
    sessionTtlMs: Number(process.env.FIXTURE_SESSION_SECONDS ?? 1800) * 1000,
    calendar: process.env.FIXTURE_CALENDAR_CONFIG
      ? loadCalendarConfig(resolve(process.env.FIXTURE_CALENDAR_CONFIG))
      : undefined,
  },
);
server.listen(port, host, () =>
  console.log(
    `Synthetic test workspace: http://${host}:${port}/v1/a (or /v1/b). ${process.env.FIXTURE_MODEL_CONFIG ? "OpenRouter interpretation enabled." : "Deterministic interpretation."} ${voiceDirectory ? `Voice: ${voiceEngine}.` : "Voice disabled."} Pairing required. Calendar writes only for an explicitly configured scope and approved proposal. Run ${process.env.FIXTURE_CALENDAR_CONFIG ? "npm run fixture:calendar:pair" : "npm run fixture:pair -- demo-user a"}.`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => server.close());
server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(
    `Fixture could not listen on ${host}:${port} (${error.code ?? "server_error"}).`,
  );
  process.exitCode = 1;
});
