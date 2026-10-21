import { transcribeAudio } from "../apps/server-integrations/transcription";
import type {
  CatalogModel,
  Provider,
} from "../packages/protocol/service-catalog";
import type {
  IntegrationTransport,
  TransportRequest,
} from "../apps/server-integrations/transport";

const provider: Provider = {
  id: "provider-1",
  revision: 1,
  name: "TEST provider",
  url: "https://openrouter.ai/api/v1",
  enabled: true,
  dailyRequestLimit: 10,
  hasCredential: true,
  requestsToday: 0,
};
const model: CatalogModel = {
  id: "model-1",
  revision: 1,
  providerId: provider.id,
  name: "TEST voice",
  model: "google/gemini-3.1-flash-lite",
  kind: "chat",
  enabled: true,
  tools: false,
  audioInput: true,
  audioOutput: false,
};

test.each(["interpreter", "transcription"] as const)(
  "%s preserves speech in another language without forcing the UI language",
  async (method) => {
    for (const [language, transcript] of [
      ["en", "Najdi Petra Nováka v CRM."],
      ["cs", "Find Peter Novak in the CRM."],
    ] as const) {
      const calls: TransportRequest[] = [];
      const dispatch = jest.fn(async (start: () => void) => start());
      const transport: IntegrationTransport = async (request) => {
        await request.beforeDispatch?.(() => calls.push(request));
        return {
          status: 200,
          headers: {},
          text: JSON.stringify(
            method === "transcription"
              ? { text: transcript }
              : {
                  choices: [
                    {
                      finish_reason: "stop",
                      message: { content: transcript },
                    },
                  ],
                },
          ),
        };
      };
      const selected = {
        provider,
        key: "TEST-voice-key",
        model:
          method === "transcription"
            ? {
                ...model,
                model: "openai/gpt-4o-mini-transcribe",
                kind: "transcription" as const,
              }
            : model,
        method,
      };
      await expect(
        transcribeAudio(
          transport,
          selected,
          Buffer.from("TEST audio"),
          language,
          new AbortController().signal,
          dispatch,
        ),
      ).resolves.toBe(transcript);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(1);
      const body = calls[0]!.body as {
        language?: string;
        messages?: { content: unknown }[];
      };
      expect(body.language).toBeUndefined();
      if (method === "interpreter") {
        expect(body.messages![0]!.content).toContain(
          language === "en" ? "do not translate" : "nepřekládej",
        );
        expect(body.messages![0]!.content).toContain(
          language === "en"
            ? "Detect the spoken language from the recording"
            : "Jazyk řeči rozpoznej z nahrávky",
        );
      }
    }
  },
);

test("cancellation still blocks every catalog ASR dispatch", async () => {
  const transport = jest.fn();
  const dispatch = jest.fn();
  const controller = new AbortController();
  controller.abort();
  await expect(
    transcribeAudio(
      transport,
      { provider, key: "TEST-voice-key", model },
      Buffer.from("TEST audio"),
      "en",
      controller.signal,
      dispatch,
    ),
  ).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
});
