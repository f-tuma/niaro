import type { IncomingMessage } from "node:http";
import { createReadStream } from "node:fs";
import { z } from "zod";
import {
  MEETING_BLOCK_BYTES,
  MEETING_PROFILE,
  MEETING_SEARCH_MAX_QUERY,
  MeetingId,
  MeetingCreateSchema,
  MeetingListSchema,
  MeetingDetailSchema,
  MeetingRenameSchema,
} from "../../packages/protocol/meetings";
import {
  HumanTaskId,
  HumanTaskCommandSchema,
  HumanTaskListSchema,
} from "../../packages/protocol/human-tasks";
import type { IdentityService } from "./service";
import { IdentityError } from "./error";
async function bytes(req: IncomingMessage, limit: number) {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const block = Buffer.from(part);
    size += block.length;
    if (size > limit) throw new IdentityError(413, "payload_too_large");
    parts.push(block);
  }
  return Buffer.concat(parts);
}
export async function meetingRoute(
  req: IncomingMessage,
  route: string,
  url: URL,
  {
    store,
    processor,
    runtime,
    failure,
  }: Awaited<ReturnType<IdentityService["mobileMeetingAccess"]>>,
) {
  const scope = runtime.session.scope;
  const run = runtime.run;
  const response = (status: number, value: unknown) => ({ status, value });
  const single = async (fn: () => unknown) => response(200, await run(fn));
  const [, rawId, operation] = route.split("/");
  if (route === "meetings" && req.method === "GET") {
    const keys = [...url.searchParams.keys()];
    if (
      keys.some((key) => key !== "q" && key !== "include") ||
      new Set(keys).size !== keys.length ||
      (url.searchParams.has("include") &&
        url.searchParams.get("include") !== "tasks")
    )
      throw new IdentityError(400, "invalid_payload");
    const q = url.searchParams.has("q")
      ? z
          .string()
          .trim()
          .min(1)
          .max(MEETING_SEARCH_MAX_QUERY)
          .parse(url.searchParams.get("q"))
      : null;
    const tasks = url.searchParams.get("include") === "tasks";
    return single(() => {
      const hits = q === null ? null : store.search(scope, q);
      const meetings = hits
        ? hits.map((hit) => hit.meeting)
        : store.list(scope);
      const open = tasks ? store.openTasks(scope) : null;
      return MeetingListSchema.parse({
        profile: MEETING_PROFILE,
        scope,
        meetings,
        ...(open
          ? {
              openTasks: Object.fromEntries(
                meetings.flatMap((meeting) => {
                  const count = open.get(meeting.id)?.count ?? 0;
                  return count ? [[meeting.id, Math.min(80, count)]] : [];
                }),
              ),
            }
          : {}),
        ...(hits
          ? {
              matches: hits.map((hit) => ({
                meetingId: hit.meeting.id,
                field: hit.field,
                snippet: hit.snippet,
                at: hit.at,
              })),
            }
          : {}),
      });
    });
  }
  if (route === "meetings" && req.method === "POST") {
    const input = MeetingCreateSchema.parse(
      JSON.parse((await bytes(req, 4096)).toString("utf8")),
    );
    return single(() => store.create(scope, input));
  }
  const id = MeetingId.parse(rawId);
  if (route !== `meetings/${id}${operation ? "/" + operation : ""}`)
    throw new IdentityError(400, "invalid_payload");
  if (operation === "record" && req.method === "GET") {
    if (url.searchParams.size) throw new IdentityError(400, "invalid_payload");
    return single(() => store.record(scope, id));
  }
  if (!operation && req.method === "GET") {
    const after = z.coerce
      .number()
      .int()
      .min(0)
      .max(240)
      .parse(url.searchParams.get("after") ?? 0);
    if (
      [...url.searchParams.keys()].some((k) => k !== "after") ||
      url.searchParams.getAll("after").length > 1
    )
      throw new IdentityError(400, "invalid_payload");
    return single(() => {
      const segments = store.segments(scope, id, after);
      return MeetingDetailSchema.parse({
        profile: MEETING_PROFILE,
        scope,
        meeting: store.get(scope, id),
        segments: segments.slice(0, 12),
        next: segments.length > 12 ? segments[12]!.index : null,
      });
    });
  }
  if (!operation && req.method === "DELETE")
    return single(() => store.delete(scope, id));
  if (!operation && req.method === "PATCH") {
    if (url.searchParams.size) throw new IdentityError(400, "invalid_payload");
    const input = MeetingRenameSchema.parse(
      JSON.parse((await bytes(req, 2048)).toString("utf8")),
    );
    return single(() => store.rename(scope, id, input.title));
  }
  if (operation === "audio" && req.method === "DELETE") {
    if (url.searchParams.size) throw new IdentityError(400, "invalid_payload");
    return single(() => store.deleteAudio(scope, id));
  }
  if (operation === "blocks" && req.method === "POST") {
    if (
      req.headers["content-type"] !== "application/octet-stream" ||
      url.searchParams.size !== 1
    )
      throw new IdentityError(400, "invalid_payload");
    const offset = z.coerce
      .number()
      .int()
      .nonnegative()
      .parse(url.searchParams.get("offset"));
    await run(() => store.get(scope, id));
    const block = await bytes(req, MEETING_BLOCK_BYTES);
    return single(() => store.append(scope, id, offset, block));
  }
  if (operation === "seal" && req.method === "POST") {
    await run(() => store.get(scope, id));
    const hash = await store.hash(scope, id);
    return single(() => store.seal(scope, id, hash));
  }
  if (operation === "process" && req.method === "POST") {
    const input = z
      .strictObject({ profile: z.literal(MEETING_PROFILE), retry: z.boolean() })
      .parse(JSON.parse((await bytes(req, 512)).toString("utf8")));
    // Without its sound a meeting can't be transcribed again.
    if ((await run(() => store.get(scope, id))).audioDeletedAt)
      throw new IdentityError(409, "meeting_audio_deleted");
    return response(
      202,
      await processor.start(
        {
          scope,
          run,
          failure,
          transcriber: runtime.transcriber,
          meetingTranscriber: runtime.meetingTranscriber,
          timeZone: runtime.timeZone,
          analyzer: runtime.meetingAnalyzer,
        },
        id,
        input.retry,
      ),
    );
  }
  return response(405, { error: "method_not_allowed" });
}

/**
 * `GET /meetings/:id/audio`: the owner's sealed recording, whole or one
 * byte range (`Range: bytes=a-b`), so a player can seek. A deleted sound
 * answers 404 `meeting_audio_not_found`.
 */
export async function meetingAudioRoute(
  req: IncomingMessage,
  route: string,
  url: URL,
  {
    store,
    runtime,
  }: Awaited<ReturnType<IdentityService["mobileMeetingAccess"]>>,
): Promise<{
  status: number;
  headers: Record<string, string>;
  body: ReturnType<typeof createReadStream> | null;
}> {
  const [, rawId, operation] = route.split("/");
  const id = MeetingId.parse(rawId);
  if (
    route !== `meetings/${id}/audio` ||
    operation !== "audio" ||
    url.searchParams.size
  )
    throw new IdentityError(400, "invalid_payload");
  if (req.method !== "GET" && req.method !== "HEAD")
    return { status: 405, headers: {}, body: null };
  const scope = runtime.session.scope;
  const audio = await runtime.run(() => store.audio(scope, id));
  const range = req.headers.range;
  let start = 0,
    end = audio.bytes - 1,
    status = 200;
  if (range) {
    const match = /^bytes=(\d{0,12})-(\d{0,12})$/.exec(range.trim());
    if (!match || (!match[1] && !match[2]))
      return {
        status: 416,
        headers: { "Content-Range": `bytes */${audio.bytes}` },
        body: null,
      };
    if (match[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    } else start = Math.max(0, audio.bytes - Number(match[2]));
    if (start > end || start >= audio.bytes)
      return {
        status: 416,
        headers: { "Content-Range": `bytes */${audio.bytes}` },
        body: null,
      };
    status = 206;
  }
  return {
    status,
    headers: {
      "Content-Type": audio.mimeType,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      ...(status === 206
        ? { "Content-Range": `bytes ${start}-${end}/${audio.bytes}` }
        : {}),
    },
    body:
      req.method === "HEAD"
        ? null
        : createReadStream(audio.path, { start, end }),
  };
}

export async function humanTaskRoute(
  req: IncomingMessage,
  route: string,
  url: URL,
  access: Awaited<ReturnType<IdentityService["mobileMeetingAccess"]>>,
) {
  const { store, runtime } = access;
  const scope = runtime.session.scope;
  if (route === "human-tasks" && req.method === "GET") {
    if (
      [...url.searchParams.keys()].some((k) => k !== "tab" && k !== "after") ||
      url.searchParams.getAll("tab").length > 1 ||
      url.searchParams.getAll("after").length > 1
    )
      throw new IdentityError(400, "invalid_payload");
    const tab = z.enum(["open", "done"]).parse(url.searchParams.get("tab"));
    const after = url.searchParams.has("after")
      ? HumanTaskId.parse(url.searchParams.get("after"))
      : undefined;
    return {
      status: 200,
      value: await runtime.run(() =>
        HumanTaskListSchema.parse(store.humanTasks.list(scope, tab, after)),
      ),
    };
  }
  if (url.searchParams.size) throw new IdentityError(400, "invalid_payload");
  const raw = route.split("/")[1];
  const id = HumanTaskId.parse(decodeURIComponent(raw ?? ""));
  if (route !== `human-tasks/${encodeURIComponent(id)}`)
    throw new IdentityError(400, "invalid_payload");
  if (req.method === "GET")
    return {
      status: 200,
      value: await runtime.run(() => store.humanTasks.get(scope, id)),
    };
  if (req.method === "POST") {
    const input = HumanTaskCommandSchema.parse(
      JSON.parse((await bytes(req, 2048)).toString("utf8")),
    );
    return {
      status: 200,
      value: await runtime.run(() =>
        store.humanTasks.command(scope, id, input),
      ),
    };
  }
  return { status: 405, value: { error: "method_not_allowed" } };
}
