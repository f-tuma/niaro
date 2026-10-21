import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy, Pencil, RefreshCw } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Separator } from "@admin/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@admin/components/ui/tooltip";
import { useChatCopy } from "./chat-copy";
import type { Language } from "../../../../packages/protocol";

const locale = (language: Language) => (language === "cs" ? "cs-CZ" : "en-GB");
const startOfDay = (value: Date) =>
  new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();

/** When a message was sent: the time, with the full date on hover. */
function MessageTime({ at }: { at: string }) {
  const { language } = useChatCopy();
  const date = new Date(at);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          dateTime={at}
          className="self-center px-1 text-xs text-muted-foreground tabular-nums"
        >
          {date.toLocaleTimeString(locale(language), {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
      </TooltipTrigger>
      <TooltipContent>
        {date.toLocaleString(locale(language), {
          dateStyle: "full",
          timeStyle: "short",
        })}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * For each message, the day it starts when that differs from the timed
 * message before it (for the first one, from today). Messages without a time
 * never start one, so a chat from before message times shows no dividers.
 */
export function messageDays(
  messages: readonly { createdAt?: string }[],
  now = new Date(),
) {
  let previous = startOfDay(now);
  return messages.map(({ createdAt }) => {
    if (!createdAt) return undefined;
    const day = startOfDay(new Date(createdAt));
    if (day === previous) return undefined;
    previous = day;
    return day;
  });
}

/** A quiet divider between the days of a chat. */
export function DaySeparator({ day }: { day: number }) {
  const { tr, language } = useChatCopy();
  const today = startOfDay(new Date());
  const date = new Date(day);
  const label =
    day === today
      ? tr("chatsToday")
      : today - day <= 86_400_000 && today > day
        ? tr("chatsYesterday")
        : date.toLocaleDateString(locale(language), {
            weekday: "long",
            day: "numeric",
            month: "long",
            ...(date.getFullYear() === new Date().getFullYear()
              ? {}
              : { year: "numeric" }),
          });
  return (
    <div
      role="separator"
      aria-label={label}
      className="flex items-center gap-3 text-xs text-muted-foreground"
    >
      <Separator className="flex-1" />
      <span>{label}</span>
      <Separator className="flex-1" />
    </div>
  );
}

function Action({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Quiet actions under a message: shown on hover on a desktop, always on a
 * phone. Copy takes the message as written (an answer's Markdown too);
 * "Again" asks once more and "Edit" brings the text back to the composer,
 * both as a new message, never changing what was said.
 */
export function MessageActions({
  text,
  align,
  createdAt,
  disabled = false,
  onAgain,
  onEdit,
}: {
  text: string;
  align: "start" | "end";
  /** When the server stored the message; older messages have none. */
  createdAt?: string;
  disabled?: boolean;
  onAgain?: () => void;
  onEdit?: () => void;
}) {
  const { copy } = useChatCopy();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div
      data-testid="message-actions"
      data-align={align}
      className="flex gap-0.5 transition-opacity data-[align=end]:justify-end md:opacity-0 md:group-focus-within/message:opacity-100 md:group-hover/message:opacity-100"
    >
      {createdAt && <MessageTime at={createdAt} />}
      <Action
        label={copied ? copy.copied : copy.copyMessage}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(text)
            .then(() => setCopied(true))
            .catch(() => {});
        }}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </Action>
      {onEdit && (
        <Action label={copy.editMessage} disabled={disabled} onClick={onEdit}>
          <Pencil aria-hidden="true" />
        </Action>
      )}
      {onAgain && (
        <Action label={copy.again} disabled={disabled} onClick={onAgain}>
          <RefreshCw aria-hidden="true" />
        </Action>
      )}
    </div>
  );
}
