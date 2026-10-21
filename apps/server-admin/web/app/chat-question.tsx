import { useEffect, useEffectEvent, useId, useState } from "react";
import { PenLine } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Checkbox } from "@admin/components/ui/checkbox";
import { Kbd } from "@admin/components/ui/kbd";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@admin/components/ui/item";
import type { NativeQuestion } from "../../../../packages/protocol";
import { useChatCopy } from "./chat-copy";

/** Typing goes to the field; digits there are text, not choices. */
export const isTypingTarget = (target: EventTarget | null) => {
  const element = target as Partial<HTMLElement> | null;
  return (
    !!element &&
    (element.isContentEditable === true ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName ?? ""))
  );
};

/** Page-wide shortcuts; a host without a window keyboard has none. */
export function listenForKeys(listener: (event: KeyboardEvent) => void) {
  if (
    typeof window === "undefined" ||
    typeof window.addEventListener !== "function"
  )
    return () => {};
  window.addEventListener("keydown", listener);
  return () => window.removeEventListener("keydown", listener);
}

/** The answers an assistant question offers, one or several to pick. */
export function questionAnswer(
  question: Pick<NativeQuestion, "options">,
  picked: readonly string[],
) {
  return (question.options ?? [])
    .filter((option) => picked.includes(option))
    .join(", ");
}

/**
 * The offered answers of an assistant question. One choice answers at once;
 * several are ticked and sent together. "Other" goes back to the composer.
 * The newest open question also takes the digit keys.
 */
export function QuestionChoices({
  question,
  disabled,
  shortcuts,
  onAnswer,
  onOther,
}: {
  question: NativeQuestion;
  disabled: boolean;
  shortcuts: boolean;
  onAnswer: (answer: string) => void;
  onOther?: () => void;
}) {
  const { copy, tr } = useChatCopy();
  const id = useId();
  const [picked, setPicked] = useState<string[]>([]);
  const options = question.options ?? [];
  const multiple = !!question.multiple;
  const toggle = (option: string) =>
    setPicked((current) =>
      current.includes(option)
        ? current.filter((value) => value !== option)
        : [...current, option],
    );
  const choose = (index: number) => {
    const option = options[index];
    if (disabled || option === undefined) return;
    if (multiple) toggle(option);
    else onAnswer(option);
  };
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      isTypingTarget(event.target) ||
      !/^[1-6]$/.test(event.key)
    )
      return;
    const index = Number(event.key) - 1;
    if (index >= options.length) return;
    event.preventDefault();
    choose(index);
  });
  useEffect(() => {
    if (!shortcuts) return;
    return listenForKeys((event) => onKey(event));
  }, [shortcuts]);
  if (!options.length) return null;
  const hint = (index: number) =>
    shortcuts ? (
      <ItemActions>
        <Kbd className="hidden md:inline-flex">{index + 1}</Kbd>
      </ItemActions>
    ) : null;
  return (
    <div className="flex flex-col gap-2" data-testid="question-choices">
      <ItemGroup role="group" aria-label={tr("questionChoices")}>
        {options.map((option, index) =>
          multiple ? (
            <Item key={option} variant="outline" size="xs" asChild>
              <label htmlFor={`${id}-${index}`}>
                <ItemMedia>
                  <Checkbox
                    id={`${id}-${index}`}
                    checked={picked.includes(option)}
                    disabled={disabled}
                    onCheckedChange={() => toggle(option)}
                  />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{option}</ItemTitle>
                </ItemContent>
                {hint(index)}
              </label>
            </Item>
          ) : (
            <Item key={option} variant="outline" size="xs" asChild>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onAnswer(option)}
              >
                <ItemContent>
                  <ItemTitle>{option}</ItemTitle>
                </ItemContent>
                {hint(index)}
              </button>
            </Item>
          ),
        )}
      </ItemGroup>
      <div className="flex flex-wrap items-center gap-2">
        {multiple && (
          <Button
            size="sm"
            disabled={disabled || !picked.length}
            onClick={() => onAnswer(questionAnswer(question, picked))}
          >
            {copy.send}
          </Button>
        )}
        {onOther && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={onOther}
          >
            <PenLine data-icon="inline-start" aria-hidden="true" />
            {tr("questionOther")}
          </Button>
        )}
      </div>
    </div>
  );
}
