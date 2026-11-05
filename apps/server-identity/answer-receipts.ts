import {
  AnswerReceiptSchema,
  type AnswerReceipt,
  type ReceiptItem,
  type ReceiptSource,
} from "../../packages/protocol/answer-receipts";
import { KNOWLEDGE_LIMITS } from "../../packages/protocol/knowledge";
import { DomainCommandSchema, type DomainCommand } from "./mastra-domain";
import type { StoredInvocation } from "./service-catalog";

/** How many of a chat's latest turns carry a receipt. */
export const RECEIPT_TURNS = 40;
const MEMORY_TITLE = 120;
const clip = (value: string, size = 160) => {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > size ? text.slice(0, size - 1) + "…" : text;
};

/**
 * What the receipts read, each answered for the person asking now: a
 * service, skill, meeting, open item or memory they can no longer open
 * answers undefined and stays out of the line.
 */
export type ReceiptSources = {
  /** Runs synchronous reads inside the identity queue, with access re-checked. */
  run<T>(fn: () => T): Promise<T>;
  /** The person's latest native turns of the chat, newest first. */
  turns(): unknown[];
  invocation(id: string): StoredInvocation | undefined;
  /** Services the person may use now (enabled, with an action allowed to them). */
  usableServices(): ReadonlySet<string>;
  /** The administrator's name for a catalog model. */
  modelName(id: string): string | undefined;
  /** Skills the person may use now, by id. */
  skills(): ReadonlyMap<string, string>;
  meetingTitle(id: string): string | undefined;
  taskTitle(id: string): string | undefined;
  /** The memories among `ids` the person may read now, with their words. */
  memories(ids: string[]): Promise<ReadonlyMap<string, string>>;
  /** The files the person sent with the request, still available to them. */
  files?(commandId: string): { id: string; name: string }[];
  /** Knowledge passages among `ids` the person may read now (NIAR-298). */
  passages?(
    ids: string[],
  ): Promise<
    ReadonlyMap<
      string,
      { kind: "file" | "service"; name: string; text: string }
    >
  >;
};

const modelReason = (reason: string) =>
  reason.startsWith("fallback")
    ? ("fallback" as const)
    : reason.startsWith("escalated")
      ? ("escalation" as const)
      : undefined;

function unique(items: ReceiptItem[], max: number) {
  const seen = new Set<string>();
  return items
    .filter((item) => {
      const key = `${item.kind}:${item.id}`;
      return !seen.has(key) && !!seen.add(key);
    })
    .slice(0, max);
}

/**
 * The receipts of a chat's latest answers (NIAR-296), built only from what
 * the server recorded for each request: its service calls, memory and task
 * changes, the saved items that reached the model, skills it loaded,
 * meetings it read or was given, the person's files, the knowledge
 * passages it was given and the model of the step that wrote the answer. Never from the model's own words.
 */
export async function answerReceipts(
  sources: ReceiptSources,
): Promise<AnswerReceipt[]> {
  const { turns, usable, skills } = await sources.run(() => ({
    turns: sources
      .turns()
      .flatMap((raw) => {
        const parsed = DomainCommandSchema.safeParse(raw);
        return parsed.success ? [parsed.data] : [];
      })
      .reverse(),
    usable: sources.usableServices(),
    skills: sources.skills(),
  }));
  const wanted = turns.flatMap((turn) =>
    [
      ...(turn.replyBasis?.items ?? []).slice(0, 20),
      ...turn.memoryReceipts.map((receipt) => receipt.result.id),
    ].slice(0, 40),
  );
  const memories = wanted.length
    ? await sources.memories([...new Set(wanted)])
    : new Map<string, string>();
  const passageIds = [
    ...new Set(turns.flatMap((turn) => turn.knowledge?.passages ?? [])),
  ];
  const passages =
    passageIds.length && sources.passages
      ? await sources.passages(passageIds)
      : new Map<
          string,
          { kind: "file" | "service"; name: string; text: string }
        >();
  return sources.run(() =>
    turns.map((turn) =>
      AnswerReceiptSchema.parse(
        receipt(turn, sources, usable, skills, memories, passages),
      ),
    ),
  );
}

function receipt(
  turn: DomainCommand,
  sources: ReceiptSources,
  usable: ReadonlySet<string>,
  skills: ReadonlyMap<string, string>,
  memories: ReadonlyMap<string, string>,
  passages: ReadonlyMap<
    string,
    { kind: "file" | "service"; name: string; text: string }
  >,
): AnswerReceipt {
  const read: ReceiptItem[] = [];
  const changed: ReceiptItem[] = [];
  for (const operationId of turn.operations) {
    const call = sources.invocation(operationId);
    // Only what happened: an approval still waiting, a refusal or an
    // unknown outcome is no read or change, and the line never says so.
    if (!call || call.status !== "succeeded" || !usable.has(call.serviceId))
      continue;
    (call.effect === "write" ? changed : read).push({
      kind: "service",
      id: call.actionId,
      title: clip(call.title),
      detail: clip(call.serviceName),
    });
  }
  for (const saved of turn.memoryReceipts) {
    const text = memories.get(saved.result.id);
    if (text)
      changed.push({
        kind: "memory",
        id: saved.result.id,
        title: clip(text, MEMORY_TITLE),
      });
  }
  for (const proposal of turn.humanTaskReceipts) {
    if (proposal.result.status === "duplicate") continue;
    const title = sources.taskTitle(proposal.result.taskId);
    if (title)
      changed.push({
        kind: "task",
        id: proposal.result.taskId,
        title: clip(title),
      });
  }
  for (const closure of turn.humanTaskClosures) {
    if (closure.result.status !== "done") continue;
    const title = sources.taskTitle(closure.result.taskId);
    if (title)
      changed.push({
        kind: "task",
        id: closure.result.taskId,
        title: clip(title),
      });
  }
  const memoryItems = (turn.replyBasis?.items ?? []).flatMap(
    (id): ReceiptItem[] => {
      const text = memories.get(id);
      return text
        ? [{ kind: "memory", id, title: clip(text, MEMORY_TITLE) }]
        : [];
    },
  );
  const skillItems = (turn.skillLoads ?? []).flatMap((load): ReceiptItem[] => {
    const name = skills.get(load.skillId);
    return name ? [{ kind: "skill", id: load.skillId, title: clip(name) }] : [];
  });
  const meetingIds = [
    ...(turn.mentions ?? []).flatMap((mention) =>
      mention.kind === "meeting" ? [mention.id] : [],
    ),
    ...(turn.meetingReads ?? []),
  ];
  const meetingItems = meetingIds.flatMap((id): ReceiptItem[] => {
    const title = sources.meetingTitle(id);
    return title ? [{ kind: "meeting", id, title: clip(title) }] : [];
  });
  // The stored answer replies to the client's command id, which the run
  // keeps as the alias's outer id when it differs from its own.
  const commandId =
    turn.aliases.find((alias) => alias.commandId === turn.commandId)
      ?.outerCommandId ?? turn.commandId;
  const fileItems = (sources.files?.(commandId) ?? []).map(
    (file): ReceiptItem => ({
      kind: "file",
      id: file.id,
      title: clip(file.name),
    }),
  );
  const sourceItems = (turn.knowledge?.passages ?? []).flatMap(
    (id): ReceiptSource[] => {
      const passage = passages.get(id);
      return passage
        ? [
            {
              kind: passage.kind,
              id,
              title: clip(passage.name),
              passage: clip(passage.text, KNOWLEDGE_LIMITS.citation),
            },
          ]
        : [];
    },
  );
  const name = turn.answerModel
    ? sources.modelName(turn.answerModel.modelId)
    : undefined;
  const reason = turn.answerModel
    ? modelReason(turn.answerModel.reason)
    : undefined;
  return {
    commandId,
    read: unique(read, 20),
    changed: unique(changed, 20),
    memories: unique(memoryItems, 20),
    skills: unique(skillItems, 10),
    meetings: unique(meetingItems, 10),
    files: unique(fileItems, 10),
    sources: sourceItems.slice(0, 10),
    ...(name
      ? { model: { name: clip(name), ...(reason ? { reason } : {}) } }
      : {}),
    ...(turn.preset ? { preset: turn.preset } : {}),
  };
}
