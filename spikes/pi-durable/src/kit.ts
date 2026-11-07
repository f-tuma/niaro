import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";

export const ctx = BACKGROUND_CONTEXT;

/** One line per transcript entry: kind, role and a short content summary. */
export function describeEntry(e: EntryRecord): string {
  const m: any = e.model?.[0];
  if (!m) return `${e.kind}${e.data !== undefined ? " " + JSON.stringify(e.data).slice(0, 80) : ""}`;
  const parts: string[] = [];
  const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
  for (const c of content) {
    if (c.type === "text" && c.text) parts.push(JSON.stringify(c.text.slice(0, 90)));
    if (c.type === "toolCall") parts.push(`toolCall ${c.name}(${JSON.stringify(c.arguments)})`);
  }
  const extra = [
    m.stopReason && m.role === "assistant" ? `stop=${m.stopReason}` : "",
    m.isError ? "isError" : "",
    m.errorMessage ? `error=${JSON.stringify(m.errorMessage.slice(0, 80))}` : "",
  ].filter(Boolean);
  return `${e.kind} [${m.role}${m.toolName ? ":" + m.toolName : ""}] ${parts.join(" ")} ${extra.join(" ")}`.trim();
}

export async function transcript(conv: Conversation): Promise<EntryRecord[]> {
  const page = await conv.entries({ order: "ascending" }, 500, undefined, ctx);
  return page.items as EntryRecord[];
}

export async function printTranscript(conv: Conversation, indent = "  "): Promise<EntryRecord[]> {
  const items = await transcript(conv);
  for (const e of items) if (e.kind !== "pi.system") console.log(indent + describeEntry(e));
  return items;
}

export function check(label: string, ok: boolean, detail = ""): boolean {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
  return ok;
}
