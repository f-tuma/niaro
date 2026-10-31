import type { IncomingMessage } from "node:http";
import type { MobileRuntime } from "../server-identity/mobile";
import { IdentityError } from "../server-identity/error";
import { AttachmentError } from "../server-attachments/schema";
import {
  OUTPUT_VOICE_PROFILE,
  OUTPUT_VOICE_UPDATE_BYTES,
  OUTPUT_VOICE_SNAPSHOT_BYTES,
  OutputVoiceSnapshotSchema,
  OutputVoiceUpdateSchema,
} from "../../packages/protocol/output-voice";

/** Called only after the normal workspace authentication boundary. */
export async function outputVoiceHttp(
  req: IncomingMessage,
  url: URL,
  settings: MobileRuntime["outputVoiceSettings"],
  body: (req: IncomingMessage, limit: number) => Promise<unknown>,
  respond: (status: number, value: unknown) => void,
) {
  if (!settings) return respond(404, { error: "not_found" });
  const profiles = url.searchParams.getAll("profile");
  if (profiles.length !== 1 || profiles[0] !== OUTPUT_VOICE_PROFILE)
    return respond(406, { error: "output_voice_profile_unsupported" });
  if ([...url.searchParams.keys()].some((key) => key !== "profile"))
    return respond(400, { error: "invalid_payload" });
  if (req.method !== "GET" && req.method !== "POST")
    return respond(405, { error: "method_not_allowed" });
  let update;
  if (req.method === "POST") {
    try {
      update = OutputVoiceUpdateSchema.parse(
        await body(req, OUTPUT_VOICE_UPDATE_BYTES),
      );
    } catch (error) {
      if (
        error instanceof RangeError ||
        error instanceof SyntaxError ||
        error instanceof AttachmentError ||
        (error instanceof Error && error.name === "ZodError")
      )
        return respond(400, { error: "invalid_payload" });
      throw error;
    }
  }
  const snapshot = update ? await settings.save(update) : await settings.read();
  // Bound actual wire serialization as well as the strict parsed contract.
  const serialized = JSON.stringify(snapshot);
  const parsed = OutputVoiceSnapshotSchema.safeParse(snapshot);
  if (
    Buffer.byteLength(serialized, "utf8") > OUTPUT_VOICE_SNAPSHOT_BYTES ||
    !parsed.success
  )
    throw new IdentityError(500, "fixture_error");
  return respond(200, parsed.data);
}
