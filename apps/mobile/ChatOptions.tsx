import React, { useRef, useState } from "react";
import { Modal, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ClientSession } from "../../packages/client-core/session";
import {
  loadConversationPins,
  saveConversationPins,
} from "../../packages/client-core/conversation-preferences";
import {
  archivableConversation,
  type ConversationSummary,
  type Language,
} from "../../packages/protocol";
import { translate } from "../../packages/i18n";
import { ChatMenu, type ChatChanges } from "./ChatHistory";
import { IconButton } from "./ScreenChrome";

type Frame = { x: number; y: number; width: number; height: number };

/**
 * The chat's `…` in the top bar: the same Pin, Rename, Archive and Delete as
 * a held row in the menu, for the chat that is open. `changes` belongs to the
 * workspace, so a refusal is still shown after the menu has closed.
 */
export function ChatOptions({
  session,
  language,
  online,
  conversation,
  disabled = false,
  changes,
}: {
  session: ClientSession;
  language: Language;
  online: boolean;
  /** The open chat; none while it exists only on this device. */
  conversation?: Pick<ConversationSummary, "id" | "title">;
  disabled?: boolean;
  changes: ChatChanges;
}) {
  const tr = translate(language);
  const anchor = useRef<View>(null);
  const [menu, setMenu] = useState<{ frame?: Frame }>();
  // Pins stay on this device, as in the menu; read when the menu opens.
  const [pins, setPins] = useState<string[]>();
  const identity = session.identityKey;
  const open = () => {
    if (!conversation) return;
    setPins(undefined);
    setMenu({});
    anchor.current?.measureInWindow((x, y, width, height) =>
      setMenu((current) =>
        current ? { frame: { x, y, width, height } } : current,
      ),
    );
    void loadConversationPins(AsyncStorage, identity).then(setPins, () => {});
  };
  const pinned = !!conversation && !!pins?.includes(conversation.id);
  const togglePin = () => {
    if (!pins || !conversation) return;
    const previous = pins;
    const next = pinned
      ? pins.filter((id) => id !== conversation.id)
      : [...pins, conversation.id];
    setPins(next);
    void saveConversationPins(AsyncStorage, identity, next).catch(() =>
      setPins(previous),
    );
  };
  return (
    <>
      <View ref={anchor} collapsable={false}>
        <IconButton
          icon="more"
          label={tr("chatOptions")}
          disabled={disabled || !conversation}
          onPress={open}
        />
      </View>
      {menu && conversation ? (
        <Modal
          visible
          transparent
          animationType="none"
          onRequestClose={() => setMenu(undefined)}
        >
          <ChatMenu
            anchor="end"
            language={language}
            conversation={conversation}
            frame={menu.frame}
            pinned={pinned}
            pinsReady={!!pins}
            online={online}
            onPin={togglePin}
            onRename={(title) => changes.rename(conversation, title)}
            onArchive={
              archivableConversation(conversation.id)
                ? () => changes.archive(conversation)
                : undefined
            }
            onDelete={() => changes.remove(conversation)}
            onClose={() => setMenu(undefined)}
          />
        </Modal>
      ) : null}
    </>
  );
}
