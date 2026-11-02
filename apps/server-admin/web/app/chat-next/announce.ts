import { useEffect, useEffectEvent, useRef, useState } from "react";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Nodes } from "mdast";

/** The longest first paragraph a screen reader is given. */
const SUMMARY_MAX = 300;
/** The pause between emptying the region and the next announcement. */
export const ANNOUNCE_GAP_MS = 100;

function plain(node: Nodes): string {
  if (node.type === "break") return " ";
  if ("value" in node) return node.value;
  if ("alt" in node) return node.alt ?? "";
  if ("children" in node) return (node.children as Nodes[]).map(plain).join("");
  return "";
}

/**
 * An answer's first paragraph (in a list or quote too; a heading when there
 * is none) as plain text, Markdown stripped, for the "Answer ready"
 * announcement.
 */
export function answerSummary(text: string, max = SUMMARY_MAX): string {
  if (!text.trim()) return "";
  const tree = fromMarkdown(text, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const find = (
    nodes: readonly Nodes[],
    kind: "paragraph" | "heading",
  ): string => {
    for (const node of nodes) {
      if (node.type === kind) {
        const value = plain(node).replace(/\s+/g, " ").trim();
        if (value) return value;
      } else if (
        node.type === "blockquote" ||
        node.type === "list" ||
        node.type === "listItem"
      ) {
        const value = find(node.children as Nodes[], kind);
        if (value) return value;
      }
    }
    return "";
  };
  const blocks = tree.children as Nodes[];
  // The first paragraph says more than a heading; a heading alone will do.
  const summary = find(blocks, "paragraph") || find(blocks, "heading");
  return summary.length > max ? `${summary.slice(0, max - 1)}…` : summary;
}

/**
 * What the chat's one polite status region says: "Answer ready" and the
 * first paragraph of each answer stored while the chat is open, once.
 * Answers already there when it opened, and older pages read later, are
 * taken in silently; streamed drafts are never passed in. The region is
 * emptied first, so a second answer with the same text is announced again.
 */
export function useAnswerAnnouncement({
  messages,
  ready,
  prefix,
}: {
  /** The chat's stored messages, oldest first. */
  messages: readonly { id: string; role: string; text: string }[];
  /** The chat's history is shown; before that nothing counts as new. */
  ready: boolean;
  prefix: string;
}) {
  const [announcement, setAnnouncement] = useState("");
  const seen = useRef<Set<string> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const answers = messages.filter((message) => message.role === "assistant");
  const ids = answers.map((message) => message.id).join("\n");
  const announce = useEffectEvent((fresh: readonly string[]) => {
    const last = answers.at(-1);
    if (!last || !fresh.includes(last.id)) return;
    const summary = answerSummary(last.text);
    setAnnouncement("");
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setAnnouncement(summary ? `${prefix}. ${summary}` : prefix),
      ANNOUNCE_GAP_MS,
    );
  });
  useEffect(() => {
    if (!ready) return;
    const current = ids ? ids.split("\n") : [];
    if (!seen.current) {
      seen.current = new Set(current);
      return;
    }
    const known = seen.current;
    const fresh = current.filter((id) => !known.has(id));
    for (const id of fresh) known.add(id);
    if (fresh.length) announce(fresh);
  }, [ready, ids]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return announcement;
}
