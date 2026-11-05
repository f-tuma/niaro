import { useEffect, useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@admin/components/ui/collapsible";
import {
  NativeSelect,
  NativeSelectOption,
} from "@admin/components/ui/native-select";
import type { ClientSession } from "../../../../../packages/client-core/session";
import type { AnswerReceipt } from "../../../../../packages/protocol/answer-receipts";
import type { ChatPresets } from "../../../../../packages/protocol/model-policy";
import {
  receiptLine,
  receiptSections,
  receiptsByCommand,
  receiptVisible,
} from "../../../../../packages/client-core/answer-receipts";
import { useChatCopy } from "../chat-copy";
import { useNextChat } from "./parts";

/** What the chat knows of its answers' receipts (NIAR-296). */
export type ChatAnswerReceipts = {
  forCommand: (commandId: string) => AnswerReceipt | undefined;
};

/**
 * The receipts of this chat's latest answers, read again whenever a new
 * answer is stored (`answers` changes). A server without receipts, or a
 * failed read, shows no line: nothing is better than a wrong one.
 */
export function useAnswerReceipts(
  session: ClientSession,
  conversationId: string,
  answers: string,
): ChatAnswerReceipts {
  const query = useQuery({
    queryKey: [
      "app",
      "answer-receipts",
      session.identityKey,
      conversationId,
      answers,
    ],
    queryFn: ({ signal }) => session.readAnswerReceipts(conversationId, signal),
    enabled: !!answers,
    retry: false,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });
  const byCommand = useMemo(() => receiptsByCommand(query.data), [query.data]);
  return { forCommand: (commandId) => byCommand.get(commandId) };
}

/**
 * One muted line under an answer: what it read and changed, what was in
 * its context and which model wrote it. It opens to the details; it never
 * says how the answer was delivered.
 */
export function AnswerReceiptLine({ commandId }: { commandId?: string }) {
  const chat = useNextChat();
  const { tr } = useChatCopy();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const receipt = commandId
    ? chat.answerReceipts?.forCommand(commandId)
    : undefined;
  if (!receipt || !receiptVisible(receipt)) return null;
  const line = receiptLine(receipt, tr);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          data-testid="answer-receipt"
          aria-controls={detailsId}
          className="flex max-w-full min-w-0 items-center gap-1 rounded-sm text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronRight
            aria-hidden="true"
            data-open={open}
            className="size-3 shrink-0 transition-transform data-[open=true]:rotate-90"
          />
          <span className="sr-only">{tr("receiptDetails")}: </span>
          <span className="min-w-0 truncate">{line}</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent id={detailsId}>
        <dl
          data-testid="answer-receipt-details"
          aria-label={tr("receiptDetails")}
          className="mt-1 flex flex-col gap-1 border-l pl-3 text-xs text-muted-foreground"
        >
          {receiptSections(receipt, tr).map((section) => (
            <div key={section.key} className="flex flex-col gap-0.5">
              <dt className="font-medium text-foreground">{section.title}</dt>
              <dd>
                <ul className="flex flex-col gap-0.5">
                  {section.items.map((item) => (
                    <li key={item.id} className="break-words">
                      {item.text}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The presets the workspace lets this person pick; none when it offers none. */
export function useChatPresets(session: ClientSession) {
  const presets = useQuery({
    queryKey: ["app", "chat-presets", session.identityKey],
    queryFn: ({ signal }) => session.readChatPresets(signal),
    retry: false,
    staleTime: 60_000,
  });
  return presets.data ?? [];
}

const presetKey = (identityKey: string) => `niaro.chat-preset.${identityKey}`;
/**
 * The preset picked for the next messages, remembered on this browser per
 * account and workspace. A preset the workspace no longer offers falls back
 * to the default quietly.
 */
export function usePickedPreset(
  identityKey: string,
  presets: ChatPresets["presets"],
) {
  const [picked, setPicked] = useState<string | undefined>(() => {
    try {
      return (
        globalThis.localStorage?.getItem(presetKey(identityKey)) ?? undefined
      );
    } catch {
      return undefined;
    }
  });
  useEffect(() => {
    try {
      if (picked)
        globalThis.localStorage?.setItem(presetKey(identityKey), picked);
      else globalThis.localStorage?.removeItem(presetKey(identityKey));
    } catch {
      // A blocked storage only forgets the choice on reload.
    }
  }, [identityKey, picked]);
  const offered = presets.some((preset) => preset.id === picked)
    ? picked
    : undefined;
  return [offered, setPicked] as const;
}

/** A small select beside the composer's tools; shown only when presets are offered. */
export function PresetPicker({
  presets,
  value,
  onChange,
  disabled,
}: {
  presets: ChatPresets["presets"];
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  disabled?: boolean;
}) {
  const { tr } = useChatCopy();
  if (!presets.length) return null;
  return (
    <NativeSelect
      size="sm"
      data-testid="preset-picker"
      aria-label={tr("presetPicker")}
      value={value ?? ""}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value || undefined)}
    >
      <NativeSelectOption value="">{tr("presetDefault")}</NativeSelectOption>
      {presets.map((preset) => (
        <NativeSelectOption key={preset.id} value={preset.id}>
          {preset.name}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}
