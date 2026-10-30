import { useLayoutEffect, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { CircleCheck } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@admin/components/ui/command";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@admin/components/ui/dialog";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import type { ClientSession } from "../../../../packages/client-core/session";
import type {
  HumanTaskReference,
  Language,
} from "../../../../packages/protocol";
import { translate, type TranslationKey } from "../../../../packages/i18n";
import { attachmentCopy } from "../../../../packages/ui-catalog/attachment-presentation";

/** Uses the existing authenticated task directory; picking never decides or sends. */
export function TaskReferencePicker({
  session,
  language,
  open,
  owner,
  onOpenChange,
  onPick,
  onCloseAutoFocus,
}: {
  session: ClientSession;
  language: Language;
  open: boolean;
  owner: object | null;
  onOpenChange: (open: boolean) => void;
  onPick: (task: HumanTaskReference) => void;
  onCloseAutoFocus: (event: Event, owner: object | null) => void;
}) {
  const tr = translate(language),
    copy = attachmentCopy(language);
  const query = useInfiniteQuery({
    queryKey: ["app", "task-reference", session.identityKey],
    enabled: open,
    retry: false,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => session.readHumanTasks("open", pageParam),
    getNextPageParam: (page) => page.next ?? undefined,
    staleTime: 0,
    gcTime: 0,
  });
  const tasks = query.data?.pages.flatMap((page) => page.tasks) ?? [];
  const latest = useRef({ session, open, owner, onPick });
  const pending = useRef<object | null>(null);
  const [selection, setSelection] = useState<{
    session: ClientSession;
    owner: object;
    checking: boolean;
    error?: TranslationKey;
  }>();
  useLayoutEffect(() => {
    latest.current = { session, open, owner, onPick };
  });
  useLayoutEffect(
    () => () => {
      pending.current = null;
    },
    [session, open, owner],
  );
  const selectionState =
    open && selection?.session === session && selection.owner === owner
      ? selection
      : undefined;
  const checking = !!selectionState?.checking;
  const choose = async (id: string) => {
    const captured = latest.current;
    if (!captured.open || !captured.owner || pending.current) return;
    const request = {};
    const identity = captured.session.identityKey;
    const selectionOwner = captured.owner;
    pending.current = request;
    setSelection({
      session: captured.session,
      owner: selectionOwner,
      checking: true,
    });
    const current = () =>
      pending.current === request &&
      latest.current.open &&
      latest.current.owner === selectionOwner &&
      latest.current.session === captured.session &&
      latest.current.session.identityKey === identity;
    try {
      // Existing authenticated read validates current scope/id. It has no AbortSignal port;
      // closing/replacing the owner drops late completion without claiming transport cancellation.
      const task = await captured.session.readHumanTask(id);
      if (!current()) return;
      if (task.id !== id || task.status !== "open")
        throw Error("human_task_not_found");
      latest.current.onPick({ id: task.id, title: task.title });
    } catch (error) {
      if (current())
        setSelection({
          session: captured.session,
          owner: selectionOwner,
          checking: false,
          error:
            error instanceof Error && error.message === "human_task_not_found"
              ? "human_task_not_found"
              : "human_task_load_failed",
        });
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setSelection((value) =>
          value?.owner === selectionOwner && value.session === captured.session
            ? { ...value, checking: false }
            : value,
        );
      }
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          pending.current = null;
          latest.current.open = false;
          setSelection(undefined);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onCloseAutoFocus(event, owner);
        }}
      >
        <DialogHeader>
          <DialogTitle>{copy.task}</DialogTitle>
        </DialogHeader>
        <Command>
          <CommandInput
            placeholder={language === "cs" ? "Hledat úkol" : "Find a task"}
          />
          <CommandList aria-busy={checking}>
            {query.isPending ? (
              <p role="status">{tr("humanTaskLoading")}</p>
            ) : query.isError ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {tr("human_task_load_failed")}
                </AlertDescription>
                <Button variant="outline" onClick={() => void query.refetch()}>
                  {tr("humanTaskRefresh")}
                </Button>
              </Alert>
            ) : (
              <>
                <CommandEmpty>{tr("humanTaskEmptyOpen")}</CommandEmpty>
                <CommandGroup>
                  {tasks.map((task) => (
                    <CommandItem
                      key={task.id}
                      value={`${task.id} ${task.title}`}
                      disabled={checking}
                      onSelect={() => void choose(task.id)}
                    >
                      <CircleCheck aria-hidden="true" />
                      <span>{task.title}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
        {checking ? <p role="status">{tr("humanTaskLoading")}</p> : null}
        {selectionState?.error ? (
          <Alert variant="destructive">
            <AlertDescription>{tr(selectionState.error)}</AlertDescription>
          </Alert>
        ) : null}
        {query.hasNextPage ? (
          <Button
            variant="outline"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {tr("humanTaskNext")}
          </Button>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{tr("cancel")}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
