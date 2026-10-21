import { useEffect, useEffectEvent, useRef, type RefObject } from "react";
import { useRouterState } from "@tanstack/react-router";

/** How long a linked message stays highlighted. */
export const MESSAGE_HIGHLIGHT_MS = 2500;
/** Older pages read while looking for a linked message (40 messages each). */
const MAX_OLDER_PAGES = 25;

/** The message id of `?m=` (a search result), as the router wrote it. */
export function linkedMessageId(search: string) {
  const raw = new URLSearchParams(search).get("m");
  if (!raw) return undefined;
  // The router quotes values that would read as JSON ("123", "true").
  if (raw.startsWith('"'))
    try {
      const value: unknown = JSON.parse(raw);
      return typeof value === "string" && value ? value : undefined;
    } catch {
      return undefined;
    }
  return raw;
}

/**
 * Opens a chat at `?m=<messageId>`: once its history is shown, reads older
 * pages until the message is there, scrolls it into the middle and
 * highlights it briefly (`data-highlighted` on its `data-message-id`
 * element). A message shown inside a card (no own element) scrolls to the
 * nearest message before it.
 */
export function useMessageLink({
  container,
  ready,
  messageIds,
  hasOlder,
  loadOlder,
  onFound,
}: {
  container: RefObject<HTMLElement | null>;
  /** The chat's history is shown and no page is loading. */
  ready: boolean;
  messageIds: readonly string[];
  hasOlder: boolean;
  loadOlder: () => void;
  /** Before scrolling: the chat stops following its end. */
  onFound: () => void;
}) {
  const target = linkedMessageId(
    useRouterState({ select: (state) => state.location.searchStr }) ?? "",
  );
  const highlight = useRef<{ node: HTMLElement; timer: number }>(undefined);
  const handled = useRef<string | undefined>(undefined);
  const pages = useRef({ target: "", read: 0 });
  const older = useEffectEvent(() => loadOlder());
  const found = useEffectEvent(() => onFound());
  const loaded = messageIds.join("\n");
  useEffect(() => {
    if (!target || !ready || handled.current === target) return;
    const root = container.current;
    if (!root) return;
    if (pages.current.target !== target) pages.current = { target, read: 0 };
    const ids = loaded.split("\n");
    const element = (id: string) =>
      [...root.querySelectorAll<HTMLElement>("[data-message-id]")].find(
        (node) => node.dataset.messageId === id,
      );
    let shown = element(target);
    if (!shown && ids.includes(target))
      for (let i = ids.indexOf(target) - 1; i >= 0 && !shown; i--)
        shown = element(ids[i]!);
    if (shown) {
      handled.current = target;
      found();
      shown.scrollIntoView?.({ block: "center" });
      const node = shown;
      if (highlight.current) {
        clearTimeout(highlight.current.timer);
        delete highlight.current.node.dataset.highlighted;
      }
      node.dataset.highlighted = "true";
      highlight.current = {
        node,
        timer: window.setTimeout(() => {
          delete node.dataset.highlighted;
          highlight.current = undefined;
        }, MESSAGE_HIGHLIGHT_MS),
      };
      return;
    }
    if (hasOlder && pages.current.read < MAX_OLDER_PAGES) {
      pages.current.read++;
      older();
    } else handled.current = target;
  }, [target, ready, loaded, hasOlder, container]);
  useEffect(
    () => () => {
      if (highlight.current) clearTimeout(highlight.current.timer);
    },
    [],
  );
}
