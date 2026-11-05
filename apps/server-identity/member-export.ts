import type { ServerResponse } from "node:http";
import { z } from "zod";
import { WorkspaceTarget } from "../../packages/protocol/connections";
import type {
  ConversationMessagePage,
  ConversationSummary,
} from "../../packages/protocol";
import type { MemoryItem } from "../../packages/protocol/memory";
import { IdentityError } from "./error";

/**
 * A person's own copy of what they see: one chat or their saved memories,
 * as Markdown or JSON, downloaded with a plain authenticated GET. Only what
 * the person's own views show is written; nothing internal (steps, tool
 * payloads, receipts, work states, source digests) leaves the server.
 */
export const CHAT_EXPORT_PROFILE = "niaro-chat-export" as const;
export const MEMORY_EXPORT_PROFILE = "niaro-memory-export" as const;
export const CHAT_EXPORT_PATH = "/admin/api/identity/conversations/export";
export const MEMORY_EXPORT_PATH = "/admin/api/identity/memory/export";

const ExportOptions = {
  format: z.enum(["md", "json"]).default("md"),
  lang: z.enum(["en", "cs"]).default("en"),
};
export const MemoryExportQuery = WorkspaceTarget.extend(ExportOptions);
export const ChatExportQuery = WorkspaceTarget.extend({
  ...ExportOptions,
  conversationId: z.string().regex(/^[a-zA-Z0-9._:-]{1,160}$/),
});
type Format = z.infer<typeof ExportOptions.format>;
type Language = z.infer<typeof ExportOptions.lang>;
type Message = ConversationMessagePage["messages"][number];

export type MemberExportFile = {
  filename: string;
  contentType: string;
  body: string;
};

const words = {
  en: {
    you: "You",
    assistant: "Assistant",
    attachments: "Attachments",
    task: "About",
    view: "Interactive view not included.",
    exported: "Exported",
    memories: "Saved memories",
    saved: "Saved",
    observed: "Observations",
    earlier: "earlier version",
    unconfirmed: "not confirmed",
    expires: "expires",
    personal: "personal",
    empty: "Nothing saved.",
    kinds: { preference: "Preference", fact: "Fact", note: "Note" },
    sections: {
      work: "Work",
      projects: "Projects",
      tools: "Tools",
      people: "People",
      style: "Style",
      rhythm: "Rhythm",
    },
  },
  cs: {
    you: "Ty",
    assistant: "Asistent",
    attachments: "Přílohy",
    task: "K úkolu",
    view: "Interaktivní zobrazení není součástí.",
    exported: "Exportováno",
    memories: "Uložená paměť",
    saved: "Uložené",
    observed: "Poznatky",
    earlier: "dřívější verze",
    unconfirmed: "nepotvrzeno",
    expires: "vyprší",
    personal: "osobní",
    empty: "Nic uloženo.",
    kinds: { preference: "Preference", fact: "Fakt", note: "Poznámka" },
    sections: {
      work: "Práce",
      projects: "Projekty",
      tools: "Nástroje",
      people: "Lidé",
      style: "Styl",
      rhythm: "Rytmus",
    },
  },
} as const;

/** A file name of plain ASCII letters, digits and dashes. */
function slug(value: string, fallback: string) {
  const ascii = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return ascii || fallback;
}
const day = (iso: string) => iso.slice(0, 10);
const minute = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** Only what the chat shows: words, file names, the task it was about. */
function visibleMessage(message: Message) {
  return {
    role: message.role,
    at: message.createdAt ?? null,
    text: message.text,
    ...(message.attachments?.length
      ? { attachments: message.attachments.map((file) => file.filename) }
      : {}),
    ...(message.humanTask ? { task: message.humanTask.title } : {}),
    ...(message.ui ? { interactiveView: "omitted" as const } : {}),
  };
}

export function chatExportFile(
  conversation: ConversationSummary,
  messages: readonly Message[],
  format: Format,
  language: Language,
  now = new Date(),
): MemberExportFile {
  const exportedAt = now.toISOString();
  const title = conversation.title.trim();
  const filename = `chat-${slug(title, "untitled")}-${day(conversation.createdAt)}.${format}`;
  const visible = messages.map(visibleMessage);
  if (format === "json")
    return {
      filename,
      contentType: "application/json; charset=utf-8",
      body: `${JSON.stringify(
        {
          profile: CHAT_EXPORT_PROFILE,
          version: 1,
          exportedAt,
          chat: {
            id: conversation.id,
            title,
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
          },
          messages: visible,
        },
        null,
        2,
      )}\n`,
    };
  const w = words[language];
  const lines = [
    `# ${title || conversation.id}`,
    "",
    `_${w.exported} ${minute(exportedAt)}_`,
  ];
  for (const message of visible) {
    lines.push(
      "",
      `### ${message.role === "user" ? w.you : w.assistant}${message.at ? ` · ${minute(message.at)}` : ""}`,
      "",
    );
    if (message.task) lines.push(`_${w.task}: ${message.task}_`, "");
    if (message.text.trim()) lines.push(message.text.trim());
    if (message.attachments)
      lines.push("", `${w.attachments}: ${message.attachments.join(", ")}`);
    if (message.interactiveView) lines.push("", `_${w.view}_`);
  }
  return {
    filename,
    contentType: "text/markdown; charset=utf-8",
    body: `${lines.join("\n")}\n`,
  };
}

/** The person's own memory as their memory page shows it, without digests or ids of sources. */
function visibleMemory(item: MemoryItem) {
  const observed = item.source?.type === "observed" ? item.source : undefined;
  return {
    origin: observed ? ("observed" as const) : ("saved" as const),
    kind: item.kind,
    status: item.status,
    text: item.content ?? "",
    ...(observed
      ? { section: observed.section, personal: observed.personal }
      : {}),
    ...(item.source?.type === "external_app"
      ? { savedBy: item.source.name }
      : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    expiresAt: item.expiresAt,
  };
}

export function memoryExportFile(
  items: readonly MemoryItem[],
  format: Format,
  language: Language,
  now = new Date(),
): MemberExportFile {
  const exportedAt = now.toISOString();
  const visible = items
    .filter((item) => item.scope === "private" && item.status !== "deleted")
    .map(visibleMemory);
  const filename = `memory-${day(exportedAt)}.${format}`;
  if (format === "json")
    return {
      filename,
      contentType: "application/json; charset=utf-8",
      body: `${JSON.stringify(
        {
          profile: MEMORY_EXPORT_PROFILE,
          version: 1,
          exportedAt,
          memories: visible,
        },
        null,
        2,
      )}\n`,
    };
  const w = words[language];
  const line = (item: (typeof visible)[number]) => {
    const notes = [
      item.section
        ? `${w.sections[item.section]}${item.personal ? `, ${w.personal}` : ""}`
        : w.kinds[item.kind],
      day(item.updatedAt),
      ...(item.status === "superseded" ? [w.earlier] : []),
      ...(item.status === "candidate" ? [w.unconfirmed] : []),
      ...(item.expiresAt ? [`${w.expires} ${day(item.expiresAt)}`] : []),
    ];
    return `- ${item.text.replace(/\s*\n\s*/g, " ")} _(${notes.join(", ")})_`;
  };
  const saved = visible.filter((item) => item.origin === "saved");
  const observed = visible.filter((item) => item.origin === "observed");
  const lines = [
    `# ${w.memories}`,
    "",
    `_${w.exported} ${minute(exportedAt)}_`,
  ];
  for (const [heading, group] of [
    [w.saved, saved],
    [w.observed, observed],
  ] as const)
    lines.push(
      "",
      `## ${heading}`,
      "",
      ...(group.length ? group.map(line) : [w.empty]),
    );
  return {
    filename,
    contentType: "text/markdown; charset=utf-8",
    body: `${lines.join("\n")}\n`,
  };
}

/** Every message of one chat, oldest first, read page by page at one revision. */
export function readWholeChat(
  read: (
    after: string | null,
    revision: number | undefined,
  ) => ConversationMessagePage | null | undefined,
) {
  const first = read(null, undefined);
  if (!first) throw new IdentityError(404, "conversation_not_found");
  let messages = first.messages;
  let after = first.nextAfter;
  for (let pages = 1; after; pages++) {
    if (pages >= 250) throw new IdentityError(413, "conversation_too_large");
    const page = read(after, first.conversation.revision);
    if (page === null) throw new IdentityError(404, "conversation_not_found");
    if (!page) throw new IdentityError(409, "conversation_changed");
    messages = [...page.messages, ...messages];
    after = page.nextAfter;
  }
  return { conversation: first.conversation, messages };
}

/** Sends the file as a download; the name also in UTF-8 for other alphabets. */
export function sendMemberExport(res: ServerResponse, file: MemberExportFile) {
  res.writeHead(200, {
    "Content-Type": file.contentType,
    "Content-Disposition": `attachment; filename="${file.filename}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(file.body);
  return true;
}
