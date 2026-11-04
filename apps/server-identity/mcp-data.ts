import { createHash } from "node:crypto";
import type { Scope } from "../../packages/protocol";
import type { AuditRecord } from "../../packages/protocol/audit";
import type { HumanTask } from "../../packages/protocol/human-tasks";
import type {
  MemoryItem,
  MemorySettings,
} from "../../packages/protocol/memory";
import {
  meetingSpeakerLabels,
  meetingTurnLabel,
  nameVoices,
  type Meeting,
} from "../../packages/protocol/meetings";
import type {
  MeetingInput,
  MemoryListInput,
  MemorySaveInput,
  SearchHit,
  TasksInput,
} from "../server-mcp/router";
import { McpToolError } from "../server-mcp/transport";
import { IdentityError } from "./error";
import { mcpScope, type McpAccessScope, type McpPrincipal } from "./mcp-access";
import type { MeetingStore } from "./meeting-store";
import type { MemoryActor, MemoryReadOptions, MemoryStore } from "./memory";
import {
  memoryQueryTerms,
  memoryScores,
  sameMemoryText,
} from "./memory-ranking";
import { containsCredential } from "./profile-material";

/**
 * Niaro data for the person's own AI app over MCP: the same stores and the
 * same visibility as their app session, for the grant's workspace only. Every
 * call re-authenticates the grant. Nothing here calls a model.
 */
export type McpDataDependencies = {
  /** Current grant and membership, inside the identity queue. */
  principal(
    grantId: string,
    serverId: string,
    scopes: McpAccessScope[],
  ): McpPrincipal;
  serial<T>(fn: () => T | Promise<T>): Promise<T>;
  meetings: MeetingStore;
  memory: MemoryStore;
  memorySettings(workspaceId: string): {
    enabled: boolean;
    settings: MemorySettings;
  };
  memoryReadOptions(
    role: McpPrincipal["role"],
  ): Pick<MemoryReadOptions, "sourceAccess" | "observationSourceView">;
  /** Followers of the person's profile (the app's pet) refresh quietly. */
  memorySaved(actor: MemoryActor): void;
  audit(record: AuditRecord): void;
};

const failures: Record<string, [string, string]> = {
  meeting_not_found: [
    "not_found",
    "No meeting with this id exists for this person. Find it with niaro_search first.",
  ],
  human_task_not_found: [
    "invalid_cursor",
    "This cursor is no longer valid. Omit cursor to start again.",
  ],
  memory_context_changed: [
    "changed",
    "The person's memory changed meanwhile. Call the tool again; omit cursor to start again.",
  ],
  memory_opted_out: [
    "memory_off",
    "The person turned off saving to their Niaro memory. Do not save; tell them if it matters.",
  ],
  memory_capacity: [
    "memory_full",
    "The person's Niaro memory is full. Ask them to delete old memories in their profile.",
  ],
  meeting_source_invalid: [
    "not_ready",
    "This meeting's record is being updated. Try again shortly.",
  ],
};
function publicFailure(error: unknown): never {
  if (error instanceof McpToolError) throw error;
  if (error instanceof IdentityError) {
    const known = failures[error.code];
    if (known) throw new McpToolError(known[0], known[1]);
    if (error.status === 401 || error.status === 403)
      throw new McpToolError(
        "access_denied",
        "This access is no longer valid for the workspace. Ask the person to connect the app again.",
      );
  }
  throw error;
}

const clock = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600),
    m = Math.floor((total % 3600) / 60),
    s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};
const short = (value: string, size: number) => {
  const flat = value.replace(/\s+/gu, " ").trim();
  return flat.length > size ? flat.slice(0, size - 1).trimEnd() + "…" : flat;
};
const normalized = sameMemoryText;
const offsetCursor = (offset: number) =>
  Buffer.from(JSON.stringify({ offset })).toString("base64url");
function readOffset(cursor: string | undefined) {
  if (!cursor) return 0;
  try {
    const { offset } = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { offset?: unknown };
    if (Number.isSafeInteger(offset) && (offset as number) >= 0)
      return offset as number;
  } catch {
    /* Answered below. */
  }
  throw new McpToolError(
    "invalid_cursor",
    "This cursor is not valid. Use the nextCursor of the previous result, or omit it to start again.",
  );
}
const meetingState = (meeting: Meeting) =>
  meeting.status === "ready"
    ? "ready"
    : meeting.status === "failed" || meeting.status === "interrupted"
      ? "failed"
      : "processing";
function savedBy(item: MemoryItem) {
  switch (item.source?.type) {
    case "user_note":
      return "the person";
    case "user_message":
      return "chat with Niaro";
    case "verified_operation":
      return "a service result";
    case "external_app":
      return item.source.name;
    case "observed":
      return "noticed by Niaro";
    default:
      return null;
  }
}

export class McpDataTools {
  constructor(private deps: McpDataDependencies) {}
  /** The grant's current principal and its data scope, checked again now. */
  private current(context: McpPrincipal, scope: McpAccessScope) {
    const principal = this.deps.principal(context.grantId, context.serverId, [
      scope,
    ]);
    return { principal, scope: mcpScope(principal) as Scope };
  }
  private read<T>(
    context: McpPrincipal,
    fn: (current: ReturnType<McpDataTools["current"]>) => T,
  ): Promise<T> {
    return this.deps
      .serial(() => fn(this.current(context, "data.read")))
      .catch(publicFailure);
  }
  /** The person's current data scope, for reads served outside identity. */
  dataScope(context: McpPrincipal) {
    return this.read(context, ({ scope }) => scope);
  }
  private memoryActor(principal: McpPrincipal): MemoryActor {
    return {
      organizationId: principal.organizationId,
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      canManageShared: false,
    };
  }
  audit(context: McpPrincipal, tool: string, outcome: "succeeded" | "failed") {
    try {
      this.deps.audit({
        organizationId: context.organizationId,
        workspaceId: context.workspaceId,
        actorId: context.userId,
        source: "mcp",
        action: "mcp.data_read",
        targetId: null,
        outcome,
        details: { mcpTool: tool },
      });
    } catch {
      /* The read already happened; a closed audit log must not fail it. */
    }
  }

  /** Phrase matches first, then meetings matching the most query words. */
  searchMeetings(
    context: McpPrincipal,
    query: string,
    offset: number,
    take: number,
  ) {
    return this.read(context, ({ scope }) => {
      const store = this.deps.meetings;
      const ranked = new Map<
        string,
        { hit: ReturnType<MeetingStore["search"]>[number]; score: number }
      >();
      for (const hit of store.search(scope, query))
        ranked.set(hit.meeting.id, { hit, score: 1000 });
      const terms = memoryQueryTerms(query).slice(0, 5);
      if (terms.length > 1)
        for (const term of terms)
          for (const hit of store.search(scope, term)) {
            const entry = ranked.get(hit.meeting.id);
            if (entry) entry.score += 1;
            else ranked.set(hit.meeting.id, { hit, score: 1 });
          }
      const all = [...ranked.values()].sort(
        (a, b) =>
          b.score - a.score ||
          b.hit.meeting.recordedAt.localeCompare(a.hit.meeting.recordedAt),
      );
      const hits: SearchHit[] = all
        .slice(offset, offset + take)
        .map(({ hit }) => ({
          kind: "meetings",
          id: hit.meeting.id,
          title: hit.meeting.title,
          date: hit.meeting.recordedAt,
          snippet: nameVoices(
            hit.snippet,
            meetingSpeakerLabels(hit.meeting.language),
            hit.meeting,
          ),
          matchedIn: hit.field,
          ...(hit.at !== null ? { at: clock(hit.at) } : {}),
          ...(meetingState(hit.meeting) === "ready"
            ? {}
            : { status: meetingState(hit.meeting) }),
        }));
      return { hits, more: all.length > offset + take };
    });
  }

  searchTasks(
    context: McpPrincipal,
    query: string,
    offset: number,
    take: number,
    full: boolean,
  ) {
    return this.read(context, ({ scope }) => {
      const tasks: HumanTask[] = [];
      for (const tab of ["open", "done"] as const) {
        let after: string | undefined;
        for (let page = 0; page < 10; page++) {
          const list = this.deps.meetings.humanTasks.list(scope, tab, after);
          tasks.push(...list.tasks.filter((task) => task.status !== "removed"));
          if (!list.next) break;
          after = list.next;
        }
      }
      const scores = memoryScores(
        query,
        tasks.map((task) =>
          [task.title, task.detail, task.assignee ?? ""].join(" "),
        ),
      );
      const ranked = tasks
        .map((task, index) => ({ task, score: scores[index]! }))
        .filter((entry) => entry.score > 0)
        .sort(
          (a, b) =>
            Number(b.task.status === "open") -
              Number(a.task.status === "open") ||
            b.score - a.score ||
            b.task.createdAt.localeCompare(a.task.createdAt),
        );
      const hits: SearchHit[] = ranked
        .slice(offset, offset + take)
        .map(({ task }) => ({
          kind: "tasks",
          id: task.id,
          title: short(task.title, 200),
          date: task.createdAt,
          status: task.status,
          ...(task.dueDate || task.due
            ? { due: task.dueDate ?? task.due }
            : {}),
          ...(task.detail
            ? { snippet: full ? task.detail : short(task.detail, 200) }
            : {}),
        }));
      return { hits, more: ranked.length > offset + take };
    });
  }

  async searchMemory(
    context: McpPrincipal,
    query: string,
    offset: number,
    take: number,
  ) {
    const items = await this.memoryItems(context, false);
    const scores = memoryScores(
      query,
      items.map((item) => item.content ?? ""),
    );
    const ranked = items
      .map((item, index) => ({ item, score: scores[index]! }))
      .filter((entry) => entry.score > 0 && entry.item.status === "active")
      .sort(
        (a, b) =>
          b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt),
      );
    const hits: SearchHit[] = ranked
      .slice(offset, offset + take)
      .map(({ item }) => ({
        kind: "memory",
        id: item.id,
        title: item.content ?? "",
        date: item.seenAt ?? item.updatedAt,
        savedBy: savedBy(item),
      }));
    return { hits, more: ranked.length > offset + take };
  }

  /** Everything the person's profile shows (and workspace notes when shared). */
  private async memoryItems(context: McpPrincipal, privateOnly: boolean) {
    try {
      const { principal, settings, enabled } = await this.deps.serial(() => {
        const { principal } = this.current(context, "data.read");
        return {
          principal,
          ...this.deps.memorySettings(principal.workspaceId),
        };
      });
      if (!enabled) return [];
      const snapshot = await this.deps.memory.privateSnapshot(
        { ...this.memoryActor(principal), canManageShared: false },
        {
          settings,
          privateOnly,
          run: (fn) =>
            this.deps.serial(() => {
              this.current(context, "data.read");
              return fn();
            }),
          ...this.deps.memoryReadOptions(principal.role),
        },
      );
      return snapshot.items;
    } catch (error) {
      return publicFailure(error);
    }
  }

  meeting(context: McpPrincipal, input: MeetingInput) {
    return this.read(context, ({ scope }) => {
      const store = this.deps.meetings;
      const meeting = store.get(scope, input.meetingId);
      const labels = meetingSpeakerLabels(meeting.language);
      const named = (value: string) => nameVoices(value, labels, meeting);
      const full = input.detail === "full";
      const state = meetingState(meeting);
      const base = {
        id: meeting.id,
        title: meeting.title,
        date: meeting.recordedAt,
        language: meeting.language,
        status: state,
        ...(meeting.durationSeconds !== null
          ? { durationMinutes: Math.round(meeting.durationSeconds / 60) }
          : {}),
        ...(meeting.attendees?.length ? { attendees: meeting.attendees } : {}),
        ...(meeting.companies?.length ? { companies: meeting.companies } : {}),
      };
      if (state !== "ready" && !store.allSegments(scope, meeting.id).length)
        return {
          ...base,
          message:
            state === "failed"
              ? "This meeting could not be processed, so it has no notes or transcript."
              : "This meeting is still being processed. Try again later.",
        };
      const record = store.record(scope, meeting.id);
      const analysis = record.analysis;
      const note = (item: { text: string; at?: number }) =>
        full && item.at !== undefined
          ? { text: named(item.text), at: clock(item.at) }
          : named(item.text);
      const notes = analysis
        ? {
            summary: named(analysis.summary),
            decisions: (analysis.decisions ?? []).map(note),
            actionItems: analysis.tasks.map((task) => ({
              text: named(task.text),
              owner:
                task.owner === "me"
                  ? labels.self
                  : (task.owner ?? task.assignee ?? null),
              due: task.dueDate ?? task.due ?? null,
              ...(full && task.context ? { context: named(task.context) } : {}),
            })),
            openQuestions: (analysis.openQuestions ?? []).map(note),
            ...(full ? { keyPoints: analysis.points.map(note) } : {}),
          }
        : {
            message:
              "This meeting has no notes yet; only the transcript is available.",
          };
      const turns = record.utterances?.length
        ? record.utterances.map((turn) => ({
            at: clock(turn.start),
            speaker: meetingTurnLabel(turn, labels, meeting) || null,
            text: turn.text,
          }))
        : store
            .allSegments(scope, meeting.id)
            .filter((segment) => segment.text.trim())
            .map((segment) => ({
              at: clock(segment.startSeconds),
              speaker: null,
              text: segment.text.trim(),
            }));
      const offset = readOffset(input.cursor);
      if (offset > turns.length)
        throw new McpToolError(
          "invalid_cursor",
          "This cursor is past the end of the transcript. Omit it to start again.",
        );
      const page = turns.slice(offset, offset + input.limit);
      return {
        ...base,
        ...notes,
        transcript: {
          turns: page,
          total: turns.length,
          nextCursor:
            offset + page.length < turns.length
              ? offsetCursor(offset + page.length)
              : null,
          ...(record.transcriptComplete ? {} : { complete: false }),
        },
      };
    });
  }

  tasks(context: McpPrincipal, input: TasksInput) {
    return this.read(context, ({ scope }) => {
      const store = this.deps.meetings.humanTasks;
      // A page of the store holds done and removed items together; removed
      // ones are left out, so read on until one more than the limit is found.
      const tasks: HumanTask[] = [];
      let after = input.cursor;
      for (let read = 0; read < 20 && tasks.length <= input.limit; read++) {
        const list = store.list(scope, input.status, after);
        tasks.push(
          ...list.tasks.filter((task) => task.status === input.status),
        );
        if (!list.next) break;
        after = list.next;
      }
      const page = tasks.slice(0, input.limit);
      const more = tasks.length > input.limit;
      const full = input.detail === "full";
      return {
        status: input.status,
        tasks: page.map((task) => ({
          id: task.id,
          title: task.title,
          ...(task.dueDate || task.due
            ? { due: task.dueDate ?? task.due }
            : {}),
          ...(task.assignee ? { assignee: task.assignee } : {}),
          from:
            task.origin.kind === "meeting"
              ? {
                  meeting: task.origin.meetingTitle,
                  meetingId: task.origin.meetingId,
                }
              : "chat",
          created: task.createdAt,
          ...(task.resolution ? { closed: task.resolution.at } : {}),
          ...(full
            ? {
                detail: task.detail,
                ...(task.resolution?.reason
                  ? { closedBecause: task.resolution.reason }
                  : {}),
              }
            : {}),
        })),
        nextCursor: more ? page.at(-1)!.id : null,
        ...(page.length
          ? {}
          : {
              message:
                input.status === "open"
                  ? "The person has no open tasks in Niaro."
                  : "No finished tasks.",
            }),
      };
    });
  }

  async memoryList(context: McpPrincipal, input: MemoryListInput) {
    const items = (await this.memoryItems(context, true)).filter(
      (item) => item.status === "active",
    );
    const offset = readOffset(input.cursor);
    const page = items.slice(offset, offset + input.limit);
    const full = input.detail === "full";
    return {
      memories: page.map((item) => ({
        id: item.id,
        text: item.content,
        savedBy: savedBy(item),
        date: item.seenAt ?? item.updatedAt,
        ...(full ? { kind: item.kind, created: item.createdAt } : {}),
      })),
      total: items.length,
      nextCursor:
        offset + page.length < items.length
          ? offsetCursor(offset + page.length)
          : null,
    };
  }

  /**
   * Saves through the same store path as the person's own profile, with the
   * app as the source; the profile shows each memory and can delete it.
   */
  async memorySave(context: McpPrincipal, input: MemorySaveInput) {
    const secret = input.facts.findIndex((fact) =>
      containsCredential(fact.text),
    );
    if (secret >= 0)
      throw new McpToolError(
        "secret_refused",
        `facts[${secret}].text looks like a password, key, token, account or card number. Niaro never stores secrets; remove it and save the rest.`,
      );
    try {
      const check = () => {
        const { principal } = this.current(context, "memory.write");
        const { enabled, settings } = this.deps.memorySettings(
          principal.workspaceId,
        );
        if (!enabled)
          throw new McpToolError(
            "memory_off",
            "Memory is turned off in this Niaro workspace, so nothing can be saved.",
          );
        return { principal, settings };
      };
      const { principal, settings } = await this.deps.serial(check);
      const actor = this.memoryActor(principal);
      const options = {
        settings,
        privateOnly: true,
        run: <T>(fn: () => T) =>
          this.deps.serial(() => {
            check();
            return fn();
          }),
        ...this.deps.memoryReadOptions(principal.role),
      };
      const existing = await this.deps.memory.privateSnapshot(actor, options);
      const known = new Map(
        existing.items
          .filter((item) => item.status === "active" && item.content)
          .map((item) => [normalized(item.content!), item.id]),
      );
      const results: { text: string; status: string; id: string }[] = [];
      let saved = 0;
      for (const fact of input.facts) {
        const key = normalized(fact.text);
        const duplicate = known.get(key);
        if (duplicate) {
          results.push({
            text: fact.text,
            status: "already_saved",
            id: duplicate,
          });
          continue;
        }
        const item = await this.deps.memory.remember(
          actor,
          {
            requestId: createHash("sha256")
              .update(
                JSON.stringify([
                  "mcp-memory/1",
                  principal.grantId,
                  key,
                  existing.version,
                ]),
              )
              .digest("base64url")
              .slice(0, 43),
            content: fact.text,
            kind: fact.kind,
            scope: "private",
            source: {
              type: "external_app",
              grantId: principal.grantId,
              name: principal.label.slice(0, 100),
            },
            explicitIntent: true,
            settings,
          },
          {
            check: () => {
              check();
            },
            run: options.run,
            source: "mcp",
          },
        );
        known.set(key, item.id);
        saved++;
        results.push({ text: fact.text, status: "saved", id: item.id });
      }
      if (saved) this.deps.memorySaved(actor);
      return {
        results,
        message: saved
          ? "Saved to the person's Niaro memory; they can see and delete it in their profile."
          : "Nothing new: every fact was already saved.",
      };
    } catch (error) {
      return publicFailure(error);
    }
  }
}
