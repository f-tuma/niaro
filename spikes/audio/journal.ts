import { z } from "zod";

export const RECORDING_KEY = "agent-client.audio.last-recording.v1";
export const JOURNAL_KEY = "agent-client.audio.journal.v1";
export const RecordingSchema = z
  .object({
    uri: z.string().startsWith("file://"),
    durationMillis: z.number().finite().nonnegative(),
    bytes: z.number().int().positive(),
    interrupted: z.boolean(),
  })
  .strict();
export type LocalRecording = z.infer<typeof RecordingSchema>;
export const JournalSchema = z
  .object({
    version: z.literal(1),
    saved: RecordingSchema.optional(),
    entries: z.array(
      z
        .object({
          uri: z.string(),
          status: z.enum(["pending", "finished", "ignored"]),
          startedAt: z.number().finite().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();
export type Journal = z.infer<typeof JournalSchema>;
export type RecoveryCandidate = {
  uri: string;
  bytes: number;
  reason: "unfinished" | "unindexed";
  status: "unchecked" | "checking" | "ready" | "unreadable" | "missing";
  durationMillis?: number;
};
/** Match only the native recorder's direct children; never normalize traversal. */
export function isRecordingUri(uri: string, documentUri: string) {
  const prefix = `${documentUri.replace(/\/$/, "")}/Audio/`;
  return (
    uri.startsWith(prefix) &&
    /^recording-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.m4a$/i.test(
      uri.slice(prefix.length),
    )
  );
}
export function withEntry(
  journal: Journal,
  uri: string,
  status: Journal["entries"][number]["status"],
): Journal {
  const previous = journal.entries.find((entry) => entry.uri === uri);
  return {
    ...journal,
    entries: [
      ...journal.entries.filter((entry) => entry.uri !== uri),
      { uri, status, startedAt: previous?.startedAt ?? Date.now() },
    ],
  };
}
