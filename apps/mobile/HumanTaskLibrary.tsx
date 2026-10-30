import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import type { ClientSession } from "../../packages/client-core/session";
import { HumanTaskCommandQueue } from "../../packages/client-core/human-task-command";
import { sameScope, type Language } from "../../packages/protocol";
import {
  type HumanTask,
  type HumanTaskCommand,
  type HumanTaskTab,
} from "../../packages/protocol/human-tasks";
import { en, translate, type TranslationKey } from "../../packages/i18n";
import {
  Button,
  Group,
  Notice,
  Row,
  Stack,
  Surface,
  SectionLabel,
  Text,
} from "../../packages/ui";
import {
  HumanTaskActions,
  HumanTaskCard,
  HumanTaskDetail,
} from "../../packages/ui-catalog/HumanTaskView";
import { companionCopy } from "./companion-copy";
import { DetailSheet, EmptyState } from "./ScreenChrome";

const decisionLabel = {
  complete: "humanTaskComplete",
  remove: "humanTaskRemove",
  reopen: "humanTaskReopen",
} as const satisfies Record<HumanTaskCommand["decision"], TranslationKey>;
function failureKey(error: unknown): TranslationKey {
  return error instanceof Error &&
    /^human_task_[a-z_]+$/.test(error.message) &&
    error.message in en
    ? (error.message as TranslationKey)
    : "human_task_load_failed";
}
/**
 * What is still to be resolved. Keyed by authenticated destination; tab
 * navigation never drops a saved decision.
 */
export function HumanTaskLibrary({
  session,
  language,
  visible,
  tab,
  refreshVersion = 0,
  leading,
  onCounts,
  resolveDisabled = false,
  onResolve,
  onOpenMeeting,
}: {
  session: ClientSession;
  language: Language;
  visible: boolean;
  tab: HumanTaskTab;
  refreshVersion?: number;
  /** The assistant's own questions and approvals, listed first. */
  leading?: React.ReactNode[];
  onCounts?(owner: string, counts: { open: number; done: number }): void;
  /** A new chat cannot start now, e.g. while a request is running. */
  resolveDisabled?: boolean;
  /** Opens a chat with this item attached. */
  onResolve?(task: HumanTask): void;
  onOpenMeeting?(meetingId: string): void;
}) {
  const tr = translate(language);
  const sessionState = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const online = sessionState.status === "online";
  const [queue] = useState(
    () =>
      new HumanTaskCommandQueue({
        identityKey: session.identityKey,
        storage: AsyncStorage,
        uuid: randomUUID,
        owns: (task) => {
          const scope = session.getSnapshot().store?.scope;
          return !!scope && sameScope(task.scope, scope);
        },
        submit: (id, command) => session.submitHumanTask(id, command),
        read: (id) => session.readHumanTask(id),
      }),
  );
  const subscribeCommands = useCallback(
    (listener: () => void) => (visible ? queue.subscribe(listener) : () => {}),
    [queue, visible],
  );
  const commandState = useSyncExternalStore(
    subscribeCommands,
    queue.getSnapshot,
    queue.getSnapshot,
  );
  const [page, setPage] = useState<{ tab: HumanTaskTab; cursors: string[] }>({
    tab,
    cursors: [],
  });
  const [projection, setProjection] = useState<{
    tab: HumanTaskTab;
    after?: string;
    tasks: HumanTask[];
    next: string | null;
  }>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<TranslationKey>();
  const [menu, setMenu] = useState<HumanTask>();
  const alive = useRef(true);
  const request = useRef(0);
  const current = useRef({ tab, after: undefined as string | undefined });
  const countsCallback = useRef(onCounts);
  const cursors = page.tab === tab ? page.cursors : [];
  const after = cursors.at(-1);
  const invalidate = useCallback(() => {
    request.current++;
  }, []);
  useLayoutEffect(() => {
    countsCallback.current = onCounts;
    current.current = { tab, after };
    invalidate();
  }, [tab, after, onCounts, invalidate]);
  const tasks =
    projection?.tab === tab && projection.after === after
      ? projection.tasks
      : [];
  const next =
    projection?.tab === tab && projection.after === after
      ? projection.next
      : null;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      invalidate();
    };
  }, [queue, invalidate]);
  useEffect(() => {
    if (visible) void queue.restore();
  }, [queue, visible]);

  const load = useCallback(async () => {
    const destination = { ...current.current };
    const ticket = ++request.current;
    if (alive.current) setLoading(true);
    try {
      const result = await session.readHumanTasks(
        destination.tab,
        destination.after,
      );
      if (
        alive.current &&
        ticket === request.current &&
        current.current.tab === destination.tab &&
        current.current.after === destination.after
      ) {
        setProjection({
          ...destination,
          tasks: result.tasks,
          next: result.next,
        });
        setLoadError(undefined);
        countsCallback.current?.(session.identityKey, result.counts);
      }
    } catch (error) {
      if (alive.current && ticket === request.current)
        setLoadError(failureKey(error));
      throw error;
    } finally {
      if (alive.current && ticket === request.current) setLoading(false);
    }
  }, [session]);
  useEffect(() => {
    if (!online) return;
    void load().catch(() => {});
    const timer = setInterval(
      () => {
        void load().catch(() => {});
      },
      visible ? 5000 : 15000,
    );
    return () => {
      clearInterval(timer);
      invalidate();
    };
  }, [online, visible, tab, after, refreshVersion, load, invalidate]);
  async function decide(
    task: HumanTask,
    decision: HumanTaskCommand["decision"],
  ) {
    try {
      await queue.decide(task, decision, async () => {
        await load();
      });
    } catch (error) {
      if (alive.current) setLoadError(failureKey(error));
    }
  }
  if (!visible) return null;
  const blocked = !online || !!loadError || commandState.phase !== "idle";
  const pending = commandState.pending;
  return (
    <Stack testID="human-task-library">
      {pending ? (
        <Surface testID="human-task-recovery">
          <Stack>
            <Text role="cardTitle">{pending.task.title}</Text>
            <Text role="caption">
              {tr(decisionLabel[pending.command.decision])}
            </Text>
            <Notice error={!!commandState.error}>
              {tr(
                commandState.phase === "sending"
                  ? "humanTaskSending"
                  : "humanTaskRetryHint",
              )}
            </Notice>
            {commandState.error ? (
              <Text role="caption">
                {tr(
                  commandState.error in en
                    ? (commandState.error as TranslationKey)
                    : "human_task_delivery_uncertain",
                )}
              </Text>
            ) : null}
            <Button
              label={tr("humanTaskRetry")}
              disabled={!online || commandState.phase === "sending"}
              loading={commandState.phase === "sending"}
              onPress={() => {
                void queue.retry(async () => {
                  await load();
                });
              }}
            />
          </Stack>
        </Surface>
      ) : commandState.error ? (
        commandState.legacyPending ? (
          <Surface testID="human-task-legacy-recovery">
            <Stack>
              <Text role="cardTitle" selectable>
                {commandState.legacyPending.title ||
                  commandState.legacyPending.taskId}
              </Text>
              <Notice error>{tr("human_task_legacy_decision")}</Notice>
              <Button
                variant="secondary"
                label={tr("humanTaskLegacyReview")}
                onPress={() => {
                  void queue.acknowledgeLegacyDecision();
                }}
              />
            </Stack>
          </Surface>
        ) : (
          <Notice error>
            {tr(
              commandState.error in en
                ? (commandState.error as TranslationKey)
                : "human_task_delivery_uncertain",
            )}
          </Notice>
        )
      ) : null}
      {loadError ? (
        <Stack>
          <Notice error>{tr(loadError)}</Notice>
          <Button
            variant="quiet"
            label={tr("humanTaskRefresh")}
            disabled={!online || loading}
            onPress={() => {
              void load().catch(() => {});
            }}
          />
        </Stack>
      ) : null}
      {tab === "open" && leading?.length ? (
        <Stack>
          <SectionLabel>{companionCopy(language).needsYou}</SectionLabel>
          {leading}
        </Stack>
      ) : null}
      {tasks.length ? (
        <Group
          title={
            tab === "open" && leading?.length
              ? companionCopy(language).yourTasks
              : undefined
          }
        >
          {tasks.map((task, index) => (
            <HumanTaskCard
              key={task.id}
              task={task}
              language={language}
              // Reading stays possible offline; only the actions wait.
              disabled={commandState.phase === "sending"}
              separator={index > 0}
              pending={
                commandState.phase === "sending" && pending?.task.id === task.id
                  ? pending.command.decision
                  : undefined
              }
              onMore={() => setMenu(task)}
            />
          ))}
        </Group>
      ) : null}
      {!tasks.length &&
      !pending &&
      !loadError &&
      !(tab === "open" && leading?.length) ? (
        !online ||
        loading ||
        projection?.tab !== tab ||
        projection.after !== after ? (
          <Text role="caption" tone="secondary" style={{ textAlign: "center" }}>
            {tr(!online ? "humanTaskOffline" : "humanTaskLoading")}
          </Text>
        ) : (
          <EmptyState
            icon={tab === "done" ? "check" : "tasks"}
            title={tr(
              tab === "open" ? "humanTaskEmptyOpen" : "humanTaskEmptyDone",
            )}
          />
        )
      ) : null}
      {cursors.length || next ? (
        <Row>
          {cursors.length ? (
            <Button
              variant="quiet"
              label={tr("humanTaskPrevious")}
              disabled={loading}
              onPress={() => setPage({ tab, cursors: cursors.slice(0, -1) })}
            />
          ) : null}
          {next ? (
            <Button
              variant="quiet"
              label={tr("humanTaskNext")}
              disabled={loading}
              onPress={() => setPage({ tab, cursors: [...cursors, next] })}
            />
          ) : null}
        </Row>
      ) : null}
      {menu ? (
        <DetailSheet
          title={menu.title}
          language={language}
          onClose={() => setMenu(undefined)}
          actions={
            <HumanTaskActions
              task={menu}
              language={language}
              disabled={blocked}
              resolveDisabled={resolveDisabled}
              onResolve={
                onResolve
                  ? () => {
                      setMenu(undefined);
                      onResolve(menu);
                    }
                  : undefined
              }
              onDecide={(decision) => {
                setMenu(undefined);
                void decide(menu, decision);
              }}
            />
          }
        >
          <HumanTaskDetail
            task={menu}
            language={language}
            onOpenMeeting={
              onOpenMeeting
                ? (id) => {
                    setMenu(undefined);
                    onOpenMeeting(id);
                  }
                : undefined
            }
          />
        </DetailSheet>
      ) : null}
    </Stack>
  );
}
