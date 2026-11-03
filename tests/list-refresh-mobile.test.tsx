import React from "react";
import { AppState, type AppStateStatus } from "react-native";
import { act, render, screen } from "@testing-library/react-native";
import { HumanTaskLibrary } from "../apps/mobile/HumanTaskLibrary";
import { MeetingLibrary } from "../apps/mobile/MeetingLibrary";
import { LIST_REFRESH } from "../apps/mobile/list-refresh";
import type {
  ClientSession,
  SessionState,
} from "../packages/client-core/session";
import { fromSnapshot } from "../packages/client-core/store";
import { emptySnapshot, scopeFor } from "../packages/test-fixtures";
import { humanTaskFixture } from "../packages/test-fixtures/human-task";
import { meetingFixture } from "../packages/test-fixtures/meeting";
import {
  HUMAN_TASK_PROFILE,
  type HumanTask,
  type HumanTaskTab,
} from "../packages/protocol/human-tasks";
import type { Meeting } from "../packages/protocol/meetings";
import type { ListMarks } from "../packages/protocol/list-marks";
import { en } from "../packages/i18n";

// NIAR-285: Tasks and Meetings read the server after a change mark from the
// events poll, on opening, foreground and Refresh, never on a timer.
jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual(
    "@react-native-async-storage/async-storage/jest/async-storage-mock",
  ),
);
jest.mock("expo-crypto", () => {
  let count = 0;
  return { randomUUID: () => `TEST-refresh-${++count}` };
});
jest.mock("../apps/mobile/ProcessLaunch", () => ({
  ProcessLaunch: () => null,
}));
jest.mock("../apps/mobile/meeting-device", () => ({
  useMeetingDevice: () => ({ capture: null, durationMillis: 0 }),
}));

const flush = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
};
/** Lets time pass with fake timers, settling reads it starts. */
async function pass(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await flush();
  });
}
const appState = new Set<(state: AppStateStatus) => void>();
async function move(state: AppStateStatus) {
  await act(async () => {
    for (const listener of appState) listener(state);
    await flush();
  });
}
beforeEach(() => {
  jest.useFakeTimers();
  appState.clear();
  jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation((_type, listener) => {
      appState.add(listener as (state: AppStateStatus) => void);
      return {
        remove: () => appState.delete(listener as never),
      } as ReturnType<typeof AppState.addEventListener>;
    });
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

let sessions = 0;
/** A signed-in session as the lists see it: its connection state, the
 * change marks of its last events poll, and the two list reads. */
function session({ marks = true }: { marks?: boolean } = {}) {
  const scope = scopeFor();
  const identityKey = `TEST-refresh-${++sessions}`;
  const state: SessionState = {
    status: "online",
    store: fromSnapshot(
      `https://fixture.test/v1/${identityKey}`,
      scope,
      emptySnapshot(scope),
    ),
  } as SessionState;
  const listeners = new Set<() => void>();
  let current: ListMarks | undefined = marks
    ? { tasks: "e.1", meetings: "e.1" }
    : undefined;
  const tasks: HumanTask[] = [{ ...humanTaskFixture, scope }];
  let meetings: Meeting[] = [{ ...meetingFixture }];
  const value = {
    identityKey,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getListMarks: () => current,
    readHumanTasks: jest.fn(async (tab: HumanTaskTab) => ({
      profile: HUMAN_TASK_PROFILE,
      scope,
      next: null,
      counts: {
        open: tasks.filter((t) => t.status === "open").length,
        done: tasks.filter((t) => t.status !== "open").length,
      },
      tasks: tasks.filter((t) => (t.status === "open") === (tab === "open")),
    })),
    readHumanTask: jest.fn(),
    submitHumanTask: jest.fn(),
    readMeetings: jest.fn(async () => ({ scope, meetings })),
    readMeetingRecord: jest.fn(),
  } as unknown as ClientSession;
  return {
    session: value,
    tasks,
    setMeetings(next: Meeting[]) {
      meetings = next;
    },
    /** What the events poll brings: a moved mark tells the subscribers. */
    async bump(list: keyof ListMarks) {
      const [epoch, count] = (current ?? { tasks: "e.0", meetings: "e.0" })[
        list
      ].split(".");
      current = {
        ...(current ?? { tasks: "e.0", meetings: "e.0" }),
        [list]: `${epoch}.${Number(count) + 1}`,
      };
      await act(async () => {
        for (const listener of listeners) listener();
        await flush();
      });
    },
  };
}
const taskReads = (s: ClientSession) =>
  (s.readHumanTasks as jest.Mock).mock.calls.length;
const meetingReads = (s: ClientSession) =>
  (s.readMeetings as jest.Mock).mock.calls.length;
function tasksView(
  s: ClientSession,
  props: Partial<React.ComponentProps<typeof HumanTaskLibrary>> = {},
) {
  return (
    <HumanTaskLibrary session={s} language="en" tab="open" visible {...props} />
  );
}
function meetingsView(
  s: ClientSession,
  props: Partial<React.ComponentProps<typeof MeetingLibrary>> = {},
) {
  return <MeetingLibrary session={s} language="en" visible {...props} />;
}

test("Tasks reads once and then never on a timer while idle, on screen or hidden", async () => {
  const f = session();
  const view = render(tasksView(f.session));
  await act(flush);
  expect(taskReads(f.session)).toBe(1);
  expect(screen.getByText(humanTaskFixture.title)).toBeTruthy();
  // Left and reopened within the window with nothing changed: no read.
  view.rerender(tasksView(f.session, { visible: false }));
  await pass(LIST_REFRESH.freshMs / 2);
  view.rerender(tasksView(f.session, { visible: true }));
  await act(flush);
  expect(taskReads(f.session)).toBe(1);
  // Before NIAR-285: a read every 5 s on screen, every 15 s hidden.
  await pass(10 * 60_000);
  expect(taskReads(f.session)).toBe(1);
  view.rerender(tasksView(f.session, { visible: false }));
  await pass(10 * 60_000);
  expect(taskReads(f.session)).toBe(1);
  // A change of meetings is not a change of tasks.
  await f.bump("meetings");
  await pass(LIST_REFRESH.minGapMs);
  expect(taskReads(f.session)).toBe(1);
  // Opening a copy older than the window reads it once.
  view.rerender(tasksView(f.session, { visible: true }));
  await act(flush);
  expect(taskReads(f.session)).toBe(2);
});

test("a task change mark reads again and keeps the badge right while Tasks is hidden", async () => {
  const f = session();
  const onCounts = jest.fn();
  const view = render(tasksView(f.session, { visible: false, onCounts }));
  await act(flush);
  expect(taskReads(f.session)).toBe(1);
  expect(onCounts).toHaveBeenLastCalledWith(f.session.identityKey, {
    open: 1,
    done: 0,
  });
  // The assistant adds an item elsewhere; the events poll moves the mark.
  f.tasks.push({ ...f.tasks[0]!, id: "TEST-human-task-2", title: "Second" });
  await f.bump("tasks");
  expect(taskReads(f.session)).toBe(2);
  expect(onCounts).toHaveBeenLastCalledWith(f.session.identityKey, {
    open: 2,
    done: 0,
  });
  // A burst of changes (a meeting adding several items) reads at most once
  // per `minGapMs`, the last change included.
  f.tasks.push({ ...f.tasks[0]!, id: "TEST-human-task-3", title: "Third" });
  await f.bump("tasks");
  await f.bump("tasks");
  expect(taskReads(f.session)).toBe(2);
  await pass(LIST_REFRESH.minGapMs);
  expect(taskReads(f.session)).toBe(3);
  expect(onCounts).toHaveBeenLastCalledWith(f.session.identityKey, {
    open: 3,
    done: 0,
  });
  await pass(LIST_REFRESH.freshMs / 2);
  expect(taskReads(f.session)).toBe(3);
  // Opening Tasks shows what the badge counted, without another read.
  view.rerender(tasksView(f.session, { visible: true, onCounts }));
  await act(flush);
  expect(screen.getByText("Third")).toBeTruthy();
  expect(taskReads(f.session)).toBe(3);
});

test("coming back to the foreground reads Tasks; the background reads nothing", async () => {
  const f = session();
  render(tasksView(f.session));
  await act(flush);
  expect(taskReads(f.session)).toBe(1);
  await move("background");
  await f.bump("tasks");
  await pass(10 * 60_000);
  expect(taskReads(f.session)).toBe(1);
  await move("active");
  await pass(LIST_REFRESH.minGapMs);
  // One read for the return; the mark it carried is already in it.
  expect(taskReads(f.session)).toBe(2);
});

test("Refresh on Tasks always reads", async () => {
  const f = session();
  const view = render(tasksView(f.session, { refreshVersion: 0 }));
  await act(flush);
  view.rerender(tasksView(f.session, { refreshVersion: 1 }));
  await act(flush);
  expect(taskReads(f.session)).toBe(2);
  view.rerender(tasksView(f.session, { refreshVersion: 2 }));
  await act(flush);
  expect(taskReads(f.session)).toBe(3);
});

test("Meetings reads on opening only when its copy is older than the window or changed", async () => {
  const f = session();
  const view = render(meetingsView(f.session, { visible: false }));
  await act(flush);
  expect(meetingReads(f.session)).toBe(0);
  view.rerender(meetingsView(f.session, { visible: true }));
  await act(flush);
  expect(meetingReads(f.session)).toBe(1);
  // Closed and reopened within the window: the shown list stays.
  view.rerender(meetingsView(f.session, { visible: false }));
  await pass(LIST_REFRESH.freshMs / 2);
  view.rerender(meetingsView(f.session, { visible: true }));
  await act(flush);
  expect(meetingReads(f.session)).toBe(1);
  // Hidden, a change does not read; opening afterwards does, within the
  // window.
  view.rerender(meetingsView(f.session, { visible: false }));
  await f.bump("meetings");
  await pass(LIST_REFRESH.minGapMs);
  expect(meetingReads(f.session)).toBe(1);
  view.rerender(meetingsView(f.session, { visible: true }));
  await act(flush);
  expect(meetingReads(f.session)).toBe(2);
  // Before NIAR-285: a read every 5 s on screen.
  await pass(10 * 60_000);
  expect(meetingReads(f.session)).toBe(2);
  // Older than the window: opening reads.
  view.rerender(meetingsView(f.session, { visible: false }));
  await pass(LIST_REFRESH.freshMs);
  view.rerender(meetingsView(f.session, { visible: true }));
  await act(flush);
  expect(meetingReads(f.session)).toBe(3);
  // Refresh and the foreground read too.
  view.rerender(meetingsView(f.session, { refreshVersion: 1 }));
  await act(flush);
  expect(meetingReads(f.session)).toBe(4);
  await move("background");
  await move("active");
  expect(meetingReads(f.session)).toBe(5);
});

test("a processing meeting on screen moves on with its change marks, without a poll", async () => {
  const f = session();
  f.setMeetings([{ ...meetingFixture, status: "transcribing" }]);
  render(meetingsView(f.session));
  await act(flush);
  expect(meetingReads(f.session)).toBe(1);
  expect(screen.getByText(en.meeting_status_transcribing)).toBeTruthy();
  await pass(60_000);
  expect(meetingReads(f.session)).toBe(1);
  // The server finishes processing: `save` moves the meetings mark.
  f.setMeetings([{ ...meetingFixture, status: "ready" }]);
  await f.bump("meetings");
  expect(meetingReads(f.session)).toBe(2);
  expect(screen.queryByText(en.meeting_status_transcribing)).toBeNull();
});

test("a server without change marks: a processing meeting reads every 15 s on screen, otherwise every 2 minutes", async () => {
  const f = session({ marks: false });
  f.setMeetings([{ ...meetingFixture, status: "analyzing" }]);
  const view = render(meetingsView(f.session));
  await act(flush);
  expect(meetingReads(f.session)).toBe(1);
  await pass(LIST_REFRESH.processingMs);
  expect(meetingReads(f.session)).toBe(2);
  f.setMeetings([{ ...meetingFixture, status: "ready" }]);
  await pass(LIST_REFRESH.processingMs);
  expect(meetingReads(f.session)).toBe(3);
  await pass(LIST_REFRESH.fallbackMs - 1000);
  expect(meetingReads(f.session)).toBe(3);
  await pass(1000);
  expect(meetingReads(f.session)).toBe(4);
  // Never while the screen is hidden.
  view.rerender(meetingsView(f.session, { visible: false }));
  await pass(10 * 60_000);
  expect(meetingReads(f.session)).toBe(4);
});
