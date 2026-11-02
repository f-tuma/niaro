import { useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Input } from "@admin/components/ui/input";
import { SidebarTrigger } from "@admin/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@admin/components/ui/dropdown-menu";
import type { ClientSession } from "../../../../../packages/client-core/session";
import { useChatCopy } from "../chat-copy";
import { useAppCopy } from "../copy";
import { ChatMenuItems, chatNameField, useChatActions } from "../chat-history";

/**
 * The chat page's one line: the chat's name and, on the right, the compact
 * pet and the chat's `…` menu (Rename, Pin, Archive, Delete), the same items
 * as its sidebar row. It belongs to the page, so it stays when the sidebar is
 * collapsed or closed. On phones it also opens the sidebar.
 */
export function ChatHeader({
  session,
  chatId,
  title,
  home = false,
  pet,
}: {
  session: ClientSession;
  /** The saved chat the menu acts on; absent for a new or read-only chat. */
  chatId?: string;
  /** The name the chat is shown under. */
  title: string;
  /** The empty new chat: its name is for screen readers only. */
  home?: boolean;
  pet?: ReactNode;
}) {
  const { copy } = useChatCopy();
  const app = useAppCopy();
  const actions = useChatActions(session);
  const [editing, setEditing] = useState(false);
  // A rename shows at once, also for a chat the sidebar has not loaded,
  // until the name it replaced changes (the list or history read it).
  const [renamed, setRenamed] = useState<{ name: string; over: string }>();
  const shown = renamed?.over === title ? renamed.name : title;
  // The menu would take the focus back from the name field as it closes.
  const renaming = useRef(false);
  const pinned = !!chatId && actions.pinned.includes(chatId);
  return (
    <>
      <header
        data-testid="chat-header"
        data-home={home}
        className="flex h-12 shrink-0 items-center gap-2 px-3 md:px-4 data-[home=true]:md:h-0"
      >
        <div className="md:hidden">
          <SidebarTrigger aria-label={app.toggleSidebar} />
        </div>
        {editing && chatId ? (
          <Input
            className="max-w-md"
            {...chatNameField(
              shown,
              copy.chatName,
              (name) => {
                setRenamed(
                  name.trim() ? { name: name.trim(), over: title } : undefined,
                );
                actions.rename(chatId, name);
              },
              () => setEditing(false),
            )}
          />
        ) : (
          <h1
            data-home={home}
            className="min-w-0 truncate text-md font-semibold data-[home=true]:sr-only"
          >
            {shown}
          </h1>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {pet}
          {chatId && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={copy.chatOptions}
                >
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="min-w-48"
                onCloseAutoFocus={(event) => {
                  if (!renaming.current) return;
                  renaming.current = false;
                  event.preventDefault();
                }}
              >
                <ChatMenuItems
                  pinned={pinned}
                  pinsReady={actions.pinsReady}
                  onRename={() => {
                    renaming.current = true;
                    setEditing(true);
                  }}
                  onTogglePin={() => actions.togglePin(chatId)}
                  onArchive={actions.archive(chatId)}
                  onDelete={() =>
                    actions.requestDelete({ id: chatId, title: shown })
                  }
                />
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>
      {actions.failure && (
        <p role="alert" className="px-4 text-xs text-destructive">
          {actions.failure}
        </p>
      )}
      {actions.dialogs}
    </>
  );
}
