import React, { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import type { ClientSession } from "../../../packages/client-core/session";
import type { Language } from "../../../packages/protocol";
import type { AnswerReceipt } from "../../../packages/protocol/answer-receipts";
import type { ChatPresets } from "../../../packages/protocol/model-policy";
import {
  receiptLine,
  receiptSections,
  receiptsByCommand,
  receiptVisible,
} from "../../../packages/client-core/answer-receipts";
import { translate } from "../../../packages/i18n";
import { Disclosure, Segmented, Text } from "../../../packages/ui";

/** What the chat knows of its answers' receipts (NIAR-296). */
export type ChatAnswerReceipts = {
  forCommand: (commandId: string) => AnswerReceipt | undefined;
};

/**
 * The receipts of this chat's latest answers, read again when another
 * answer arrives (`answers` changes). A failed read shows no line.
 */
export function useAnswerReceipts(
  session: ClientSession | null,
  conversationId: string,
  answers: string,
): ChatAnswerReceipts {
  const [page, setPage] = useState<{
    owner: string;
    receipts: Map<string, AnswerReceipt>;
  }>();
  const ticket = useRef(0);
  useEffect(() => {
    const own = ++ticket.current;
    if (
      !session ||
      !answers ||
      typeof session.readAnswerReceipts !== "function"
    )
      return;
    const controller = new AbortController();
    void session.readAnswerReceipts(conversationId, controller.signal).then(
      (value) => {
        if (own === ticket.current)
          setPage({
            owner: conversationId,
            receipts: receiptsByCommand(value),
          });
      },
      () => {
        // No line is better than a wrong one; the next answer reads again.
      },
    );
    return () => controller.abort();
  }, [session, conversationId, answers]);
  const receipts = page?.owner === conversationId ? page.receipts : undefined;
  return useMemo(
    () => ({ forCommand: (commandId) => receipts?.get(commandId) }),
    [receipts],
  );
}

/**
 * One muted line under an answer: what it read and changed, what was in its
 * context and which model wrote it. It opens to the details.
 */
export function AnswerReceiptLine({
  receipts,
  commandId,
  language,
}: {
  receipts?: ChatAnswerReceipts;
  commandId?: string;
  language: Language;
}) {
  const tr = translate(language);
  const receipt = commandId ? receipts?.forCommand(commandId) : undefined;
  if (!receipt || !receiptVisible(receipt)) return null;
  return (
    <View testID="answer-receipt">
      <Disclosure label={receiptLine(receipt, tr)}>
        <View
          testID="answer-receipt-details"
          accessibilityLabel={tr("receiptDetails")}
          style={{ gap: 6 }}
        >
          {receiptSections(receipt, tr).map((section) => (
            <View key={section.key} style={{ gap: 2 }}>
              <Text role="caption" style={{ fontWeight: "600" }}>
                {section.title}
              </Text>
              {section.items.map((item) => (
                <Text key={item.id} role="caption" tone="secondary">
                  {item.text}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </Disclosure>
    </View>
  );
}

/** The presets the workspace lets this person pick; none when it offers none. */
export function useMobileChatPresets(
  session: ClientSession | null,
  online: boolean,
) {
  const [presets, setPresets] = useState<{
    session: ClientSession;
    value: ChatPresets["presets"];
  }>();
  useEffect(() => {
    if (!session || !online || typeof session.readChatPresets !== "function")
      return;
    const controller = new AbortController();
    let current = true;
    void session.readChatPresets(controller.signal).then(
      (value) => {
        if (current) setPresets({ session, value });
      },
      () => {},
    );
    return () => {
      current = false;
      controller.abort();
    };
  }, [session, online]);
  return presets?.session === session ? presets.value : [];
}

/**
 * Default and each offered preset as one radio row above the composer,
 * shown only when the workspace offers presets.
 */
export function MobilePresetPicker({
  presets,
  value,
  onChange,
  language,
}: {
  presets: ChatPresets["presets"];
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  language: Language;
}) {
  const tr = translate(language);
  if (!presets.length) return null;
  return (
    <View testID="preset-picker" style={{ paddingBottom: 6 }}>
      <Segmented
        accessibilityLabel={tr("presetPicker")}
        options={[
          { value: "", label: tr("presetDefault") },
          ...presets.map((preset) => ({
            value: preset.id,
            label: preset.name,
          })),
        ]}
        value={value ?? ""}
        onChange={(next) => onChange(next || undefined)}
      />
    </View>
  );
}
