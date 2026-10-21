import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@admin/components/ui/alert-dialog";
import {
  ConversationOpenWorkError,
  openWorkKindKey,
} from "../../../../packages/client-core/conversation-directory";
import type { OpenWork } from "../../../../packages/protocol";
import { useChatCopy } from "./chat-copy";

/** A delete or archive the server refused because work waits in the chat. */
export type OpenWorkRefusal = {
  conversationId: string;
  action: "delete" | "archive";
  openWork: readonly OpenWork[];
};
export function openWorkRefusal(
  error: unknown,
  conversationId: string,
  action: OpenWorkRefusal["action"],
): OpenWorkRefusal | undefined {
  return error instanceof ConversationOpenWorkError
    ? { conversationId, action, openWork: error.openWork }
    : undefined;
}

/**
 * Names what still waits in the chat and offers to cancel it first: questions
 * and tasks end as cancelled, approvals are declined, finished actions stay.
 */
export function OpenWorkDialog({
  refusal,
  onDismiss,
  onConfirm,
}: {
  refusal: OpenWorkRefusal | undefined;
  onDismiss: () => void;
  onConfirm: (refusal: OpenWorkRefusal) => void;
}) {
  const { tr } = useChatCopy();
  return (
    <AlertDialog
      open={!!refusal}
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{tr("chatWaiting")}</AlertDialogTitle>
          <AlertDialogDescription>
            {refusal?.openWork.length
              ? tr("chatWaitingHint")
              : tr("chatOpenWork")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {!!refusal?.openWork.length && (
          <ul
            className="flex flex-col gap-1 text-sm"
            data-testid="open-work-list"
          >
            {refusal.openWork.map((work) => (
              <li key={work.workItemId} className="flex min-w-0 gap-1">
                <span className="truncate font-medium">{work.title}</span>
                <span className="shrink-0 text-muted-foreground">
                  ({tr(openWorkKindKey(work.kind))})
                </span>
              </li>
            ))}
          </ul>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{tr("keepWaiting")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              if (refusal) onConfirm(refusal);
            }}
          >
            {tr(
              refusal?.action === "archive"
                ? "cancelAndArchive"
                : "cancelAndDelete",
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
