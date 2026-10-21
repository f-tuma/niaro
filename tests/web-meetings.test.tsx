import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ClientSession } from "../packages/client-core/session";
import {
  MEETING_PROFILE,
  type Meeting,
  type MeetingSegment,
} from "../packages/protocol/meetings";
import type { MeetingRecord } from "../packages/protocol/meeting-record";
import type { HumanTask } from "../packages/protocol/human-tasks";
import {
  meetingFixture,
  meetingRecordFixture,
} from "../packages/test-fixtures/meeting";
import { MeetingsPage } from "../apps/server-admin/web/app/meetings-page";
import { MeetingDetail } from "../apps/server-admin/web/app/meeting-detail-page";
import {
  MeetingCaptureActions,
  UnsentMeetings,
} from "../apps/server-admin/web/app/meeting-recorder";
import { meetingsRefetchInterval } from "../apps/server-admin/web/app/meetings-list";
import {
  paragraphAt,
  transcriptBlocks,
} from "../apps/server-admin/web/app/meeting-transcript-view";
import {
  UNSAVED_DRAFT,
  draftKey,
  readDraft,
} from "../apps/server-admin/web/app/chat-store";
import {
  MeetingCaptureStore,
  type CapturePorts,
} from "../apps/server-admin/web/app/meeting-capture";

const mockNavigate = jest.fn();
jest.mock("@tanstack/react-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    Link: ({
      to,
      params,
      ...props
    }: React.ComponentProps<"a"> & {
      to: string;
      params?: Record<string, string>;
    }) =>
      React.createElement("a", {
        ...props,
        href: Object.entries(params ?? {}).reduce(
          (path, [key, value]) => path.replace(`$${key}`, value),
          to,
        ),
      }),
    useNavigate: () => mockNavigate,
    useParams: () => ({}),
  };
});
let mockSession: ClientSession | null = null;
// Radix's slider needs a DOM (forms); the test renderer has none.
jest.mock("@admin/components/ui/slider", () => ({
  Slider: (props: { "aria-label"?: string }) => (
    <div role="slider" aria-label={props["aria-label"]} />
  ),
}));
jest.mock("../apps/server-admin/web/app/context", () => ({
  useApp: () => ({ language: "cs" }),
  useAppSession: () => mockSession,
}));
jest.mock("../apps/server-admin/web/app/meeting-process", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    MeetingProcessSheet: ({
      task,
    }: {
      task: { id: string; revision: number; text: string };
    }) =>
      React.createElement(
        "div",
        { "data-host": "MeetingProcessSheet", "data-revision": task.revision },
        task.text,
      ),
  };
});
const host = () =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule();
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/card", () => host(), { virtual: true });
jest.mock("@admin/components/ui/progress", () => host(), { virtual: true });
jest.mock("@admin/components/ui/spinner", () => host(), { virtual: true });
jest.mock("@admin/components/ui/alert", () => host(), { virtual: true });
jest.mock("@admin/components/ui/alert-dialog", () => host(), { virtual: true });
jest.mock("@admin/components/ui/dropdown-menu", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/ui/item", () => host(), { virtual: true });
jest.mock("@admin/components/ui/input", () => host(), { virtual: true });
jest.mock("@admin/components/ui/skeleton", () => host(), { virtual: true });
jest.mock("@admin/components/ui/empty", () => host(), { virtual: true });
jest.mock("@admin/components/ui/toggle-group", () => host(), { virtual: true });
jest.mock("@admin/components/ui/sidebar", () => host(), { virtual: true });
jest.mock(
  "@admin/components/console/page",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const slots =
      (name: string) =>
      // eslint-disable-next-line react/display-name -- test stand-in
      ({
        title,
        titleContent,
        toolbar,
        actions,
        meta,
        description,
        children,
      }: Record<string, React.ReactNode>) =>
        React.createElement(
          "section",
          { "data-host": name },
          titleContent ?? title,
          description,
          meta,
          toolbar,
          actions,
          children,
        );
    return { PageHeader: slots("PageHeader"), Section: slots("Section") };
  },
  { virtual: true },
);
jest.mock("@admin/components/console/status", () => host(), { virtual: true });
jest.mock("@admin/components/console/entity-icon", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/forms", () => host(), { virtual: true });

const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const hosts = (root: ReactTestInstance, name: string) =>
  root.findAll((node) => node.props["data-host"] === name);
const button = (root: ReactTestInstance, label: string) => {
  const found = root.findAll(
    (node) => node.type === "button" && text(node).includes(label),
  );
  if (!found.length) throw new Error(`No button "${label}"`);
  return found[0]!;
};
const flush = async () => {
  for (let i = 0; i < 10; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
};
const mounted: { unmount(): void }[] = [];
async function render(
  element: React.ReactElement,
  options?: TestRenderer.TestRendererOptions,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>{element}</QueryClientProvider>,
      options,
    );
  });
  await flush();
  mounted.push({
    unmount: () => {
      renderer.unmount();
      client.clear();
    },
  });
  return renderer;
}

const meeting = (patch: Partial<Meeting>): Meeting => ({
  ...meetingFixture,
  ...patch,
});
const scope = meetingFixture.scope;

beforeEach(() => {
  jest.spyOn(URL, "createObjectURL").mockReturnValue("blob:TEST-audio");
  jest.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  for (const entry of mounted.splice(0)) act(() => entry.unmount());
  jest.restoreAllMocks();
  mockNavigate.mockReset();
  mockSession = null;
});

test("the list shows each meeting's state, date and length and filters by title", async () => {
  const meetings = [
    meeting({
      id: "11111111-1111-4111-8111-111111111111",
      title: "Porada s Janem",
      durationSeconds: 1800,
      language: "cs",
    }),
    meeting({
      id: "22222222-2222-4222-8222-222222222222",
      title: "Klient Šťastný",
      status: "transcribing",
      durationSeconds: null,
    }),
    meeting({
      id: "33333333-3333-4333-8333-333333333333",
      title: "Nabídka",
      status: "failed",
      failure: "meeting_audio_invalid",
    }),
  ];
  mockSession = {
    identityKey: "identity-1",
    readMeetings: jest.fn(async () => ({
      profile: MEETING_PROFILE,
      scope,
      meetings,
    })),
  } as unknown as ClientSession;
  const renderer = await render(<MeetingsPage />);
  const root = renderer.root;
  const links = root.findAll(
    (node) => node.type === "a" && !!node.props.href?.startsWith("/meetings/"),
  );
  expect(links.map((link) => link.props.href)).toEqual(
    meetings.map((m) => `/meetings/${m.id}`),
  );
  expect(text(links[0]!)).toContain("30 min");
  // Ready needs no badge; work in progress and failures do.
  expect(hosts(root, "StatusBadge").map(text)).toEqual([
    "Přepisuje se",
    "Selhalo",
  ]);
  expect(text(links[2]!)).toContain("Zvuk nelze přečíst");
  const search = hosts(root, "SearchField")[0]!;
  await act(async () => search.props.onChange("stastny"));
  expect(
    root
      .findAll((node) => node.type === "a")
      .filter((node) => node.props.href?.startsWith("/meetings/")),
  ).toHaveLength(1);
  const filter = hosts(root, "ToggleGroup")[0]!;
  await act(async () => {
    search.props.onChange("");
    filter.props.onValueChange("failed");
  });
  const shown = root
    .findAll((node) => node.type === "a")
    .filter((node) => node.props.href?.startsWith("/meetings/"));
  expect(shown.map(text).join()).toContain("Nabídka");
  expect(shown).toHaveLength(1);
});

test("an unsent recording offers to send again, save or discard", async () => {
  const store = new MeetingCaptureStore({
    uuid: () => "8a4b8f0e-5d0c-4a52-9b0e-1f2d3c4b5a69",
    now: () => Date.UTC(2026, 9, 1),
  } as CapturePorts);
  await store.addFile(
    new File([new Uint8Array(2048)], "call.m4a"),
    "identity-1",
    "cs",
    "Schůzka · 1. 10.",
  );
  const session = {
    identityKey: "identity-1",
    createMeeting: jest.fn(async () => {
      throw new Error("meeting_connection_failed");
    }),
  } as unknown as ClientSession;
  const renderer = await render(
    <UnsentMeetings session={session} store={store} onUploaded={jest.fn()} />,
  );
  await act(async () => button(renderer.root, "Odeslat znovu").props.onClick());
  expect(session.createMeeting).toHaveBeenCalledTimes(1);
  expect(text(renderer.root)).toContain("Server nedostupný");
  expect(text(renderer.root)).toContain("Uložit soubor");
  const discard = hosts(renderer.root, "ConfirmAction")[0]!;
  await act(async () => discard.props.onConfirm());
  expect(store.getSnapshot().captures).toEqual([]);
});

function twoTrack(): {
  record: MeetingRecord;
  segments: MeetingSegment[];
} {
  const self = "Já: Domluvím další schůzku na pátek.";
  const others = "Ostatní: Pošlete nám prosím nabídku.";
  const record: MeetingRecord = {
    ...meetingRecordFixture,
    meeting: {
      ...meetingFixture,
      language: "cs",
      title: "Nabídka pro klienta",
      speakerChannels: "self-others",
    },
    transcript: `${others}\n${self}`,
    analysis: {
      summary: "Klient chce nabídku.",
      summarySources: [{ segment: 0, quote: others }],
      points: [],
      tasks: [
        {
          text: "Domluvit další schůzku",
          assignee: null,
          due: "pátek",
          sources: [{ segment: 0, quote: self }],
        },
      ],
      overflow: false,
    },
  };
  return {
    record,
    segments: [
      {
        index: 0,
        startSeconds: 0,
        endSeconds: 60,
        text: `${others}\n${self}`,
        reviewReasons: [],
        transcriber: "TEST",
        analyzer: null,
        analysis: null,
      },
    ],
  };
}

function detailSession(record: MeetingRecord, segments: MeetingSegment[]) {
  return {
    identityKey: "identity-1",
    readMeetingRecord: jest.fn(async () => record),
    readMeeting: jest.fn(async () => ({
      profile: MEETING_PROFILE,
      scope,
      meeting: record.meeting,
      segments,
      next: null,
    })),
    readHumanTask: jest.fn(
      async (id: string) =>
        ({
          id,
          status: "open",
          revision: 4,
          origin: {
            kind: "meeting",
            meetingId: record.meeting.id,
            recordDigest: record.recordDigest,
          },
        }) as unknown as HumanTask,
    ),
    processMeeting: jest.fn(async () => record.meeting),
    deleteMeeting: jest.fn(async () => {}),
    renameMeeting: jest.fn(async (_id: string, title: string) => ({
      ...record.meeting,
      title,
    })),
    deleteMeetingAudio: jest.fn(async () => ({
      ...record.meeting,
      audioDeletedAt: "2026-10-20T10:00:00.000Z",
    })),
    readMeetingAudio: jest.fn(
      async () => new Blob([new Uint8Array(4)], { type: "audio/mp4" }),
    ),
  };
}

test("the detail shows the record, tasks linked to Tasks and the transcript by speaker", async () => {
  const { record, segments } = twoTrack();
  const session = detailSession(record, segments);
  const renderer = await render(
    <MeetingDetail
      session={session as unknown as ClientSession}
      id={record.meeting.id}
    />,
  );
  const root = renderer.root;
  const page = text(root);
  expect(page).toContain("Klient chce nabídku.");
  expect(page).toContain("Domluvit další schůzku");
  expect(page).toContain("pátek");
  expect(
    root.findAll((node) => node.type === "a" && node.props.href === "/tasks"),
  ).toHaveLength(1);
  // The minutes read as one text: each speaker's run once, with its time.
  const transcript = root.findByProps({ "aria-label": "Přepis", role: "list" });
  expect(text(transcript)).toContain("0:00");
  const speakers = transcript.findAll(
    (node) => node.type === "span" && node.props["data-speaker"] !== undefined,
  );
  expect(
    speakers.map((node) => [text(node), node.props["data-speaker"]]),
  ).toEqual([
    ["Ostatní", "others"],
    ["Já", "self"],
  ]);
  expect(text(transcript)).toContain("Pošlete nám prosím nabídku.");
  // A quote opens its minute in the transcript.
  const quote = root.findAll(
    (node) =>
      node.type === "button" &&
      String(node.props["aria-label"]).startsWith("Ukázat v přepisu"),
  )[0]!;
  await act(async () => quote.props.onClick());
  await flush();
  expect(
    root.findByProps({ id: "meeting-focus" }).props["data-highlighted"],
  ).toBe(true);

  await act(async () => button(root, "Pokračovat procesem").props.onClick());
  await flush();
  expect(session.readHumanTask).toHaveBeenCalledWith(record.humanTaskIds[0]);
  const sheet = hosts(root, "MeetingProcessSheet")[0]!;
  expect(text(sheet)).toBe("Domluvit další schůzku");
  expect(sheet.props["data-revision"]).toBe(4);
});

test("a closed task can't continue in a process", async () => {
  const { record, segments } = twoTrack();
  const session = detailSession(record, segments);
  session.readHumanTask.mockImplementation(
    async (id: string) =>
      ({
        id,
        status: "done",
        revision: 5,
        origin: { kind: "meeting", meetingId: record.meeting.id },
      }) as unknown as HumanTask,
  );
  const renderer = await render(
    <MeetingDetail
      session={session as unknown as ClientSession}
      id={record.meeting.id}
    />,
  );
  await act(async () =>
    button(renderer.root, "Pokračovat procesem").props.onClick(),
  );
  await flush();
  expect(hosts(renderer.root, "MeetingProcessSheet")).toHaveLength(0);
  expect(text(renderer.root)).toContain("Uzavřený");
});

test("a failed meeting retries after the cost warning; delete asks and returns to the list", async () => {
  const record: MeetingRecord = {
    ...meetingRecordFixture,
    meeting: {
      ...meetingFixture,
      status: "failed",
      failure: "meeting_transcription_failed",
      completedSegments: 0,
    },
    analysis: null,
    recordDigest: null,
    humanTaskIds: [],
  };
  const session = detailSession(record, []);
  const renderer = await render(
    <MeetingDetail
      session={session as unknown as ClientSession}
      id={record.meeting.id}
    />,
  );
  const root = renderer.root;
  expect(text(root)).toContain("Přepis selhal");
  await act(async () =>
    button(root, "Zkusit zpracování znovu").props.onClick(),
  );
  const confirm = hosts(root, "AlertDialogAction")[0]!;
  await act(async () => confirm.props.onClick());
  await flush();
  expect(session.processMeeting).toHaveBeenCalledWith(record.meeting.id, true);
  const remove = hosts(root, "ConfirmAction").find(
    (node) => node.props.title === "Smazat schůzku?",
  )!;
  await act(async () => remove.props.onConfirm());
  await flush();
  expect(session.deleteMeeting).toHaveBeenCalledWith(record.meeting.id);
  expect(mockNavigate).toHaveBeenCalledWith({ to: "/meetings" });
});

/** A newer record: decisions, open questions, a task's owner and time, and
 * timed turns with speakers (read defensively, so cast here). */
function workspaceRecord(): MeetingRecord {
  const { record } = twoTrack();
  return {
    ...record,
    meeting: { ...record.meeting, consent: undefined },
    analysis: {
      ...record.analysis!,
      decisions: [
        {
          text: "Nabídku pošleme do pátku",
          sources: record.analysis!.summarySources,
          at: 5,
        },
      ],
      openQuestions: [
        {
          text: "Kdo schválí slevu?",
          sources: record.analysis!.summarySources,
          at: 42,
        },
      ],
      tasks: [
        {
          ...record.analysis!.tasks[0]!,
          owner: "me",
          dueDate: "2026-10-23",
          at: 12,
        },
      ],
    },
    utterances: [
      { start: 0, end: 4, speaker: "others", text: "Pošlete nám nabídku." },
      { start: 5, end: 11, speaker: "me", text: "Pošlu ji do pátku." },
      { start: 12, end: 20, speaker: "unknown", text: "A schůzku příště." },
    ],
  } as unknown as MeetingRecord;
}

test("the detail is a workspace: notes with times, turns by speaker, and a time seeks the player", async () => {
  const record = workspaceRecord();
  const session = detailSession(record, twoTrack().segments);
  const audio = { currentTime: 0, play: jest.fn(async () => {}) };
  const renderer = await render(
    <MeetingDetail
      session={session as unknown as ClientSession}
      id={record.meeting.id}
    />,
    { createNodeMock: (node) => (node.type === "audio" ? audio : null) },
  );
  const root = renderer.root;
  const page = text(root);
  for (const part of [
    "Shrnutí",
    "Rozhodnutí",
    "Nabídku pošleme do pátku",
    "Otevřené otázky",
    "Kdo schválí slevu?",
    "u 0:12",
    "Bez potvrzení souhlasu",
  ])
    expect(page).toContain(part);
  // The task's owner "me" reads as the person.
  expect(page).toContain("Já");
  // The columns scroll on their own, yet keep a height: a short window
  // scrolls the page instead of cutting it off.
  const [column] = root.findAll(
    (node) => node.type === "div" && node.props["data-fill"] === true,
  );
  expect(column!.props.className).toContain("overflow-y-auto");
  expect(column!.props.className).not.toContain("overflow-hidden");
  expect(
    root.findAll(
      (node) =>
        node.type === "div" &&
        /\blg:grid-cols-5\b/.test(node.props.className ?? ""),
    )[0]!.props.className,
  ).toContain("lg:min-h-96");
  // Spoken turns read as text, each speaker's run with its name.
  const speakers = root.findAll(
    (node) => node.type === "span" && node.props["data-speaker"] !== undefined,
  );
  expect(speakers.map(text)).toEqual(["Ostatní", "Já", "Neznámý"]);
  // No sound is read until the person plays or jumps.
  expect(session.readMeetingAudio).not.toHaveBeenCalled();
  expect(root.findAll((node) => node.type === "audio")).toHaveLength(0);
  await act(async () => button(root, "u 0:12").props.onClick());
  await flush();
  expect(session.readMeetingAudio).toHaveBeenCalledTimes(1);
  expect(text(root.findByProps({ id: "meeting-focus" }))).toContain(
    "A schůzku příště.",
  );
  const player = root.find((node) => node.type === "audio");
  expect(player.props.src).toMatch(/^blob:/);
  await act(async () =>
    player.props.onLoadedMetadata({ currentTarget: audio }),
  );
  expect(audio.currentTime).toBe(12);
  expect(audio.play).toHaveBeenCalledTimes(1);
  // Loaded once; the next time seeks at once.
  await act(async () => button(root, "u 0:05").props.onClick());
  expect(audio.currentTime).toBe(5);
  expect(session.readMeetingAudio).toHaveBeenCalledTimes(1);
  expect(text(root.findByProps({ id: "meeting-focus" }))).toContain(
    "Pošlu ji do pátku.",
  );
});

test("the title renames in place, Ask opens a chat with the meeting, and the menu holds the rest", async () => {
  const record = workspaceRecord();
  const session = detailSession(record, twoTrack().segments);
  const writeText = jest.fn(async () => {});
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText } },
    configurable: true,
  });
  const renderer = await render(
    <MeetingDetail
      session={session as unknown as ClientSession}
      id={record.meeting.id}
    />,
  );
  const root = renderer.root;
  await act(async () => button(root, "Nabídka pro klienta").props.onClick());
  const input = root.find(
    (node) =>
      node.type === "input" && node.props["aria-label"] === "Přejmenovat",
  );
  await act(async () =>
    input.props.onChange({ target: { value: "Nabídka – Novák" } }),
  );
  await act(async () =>
    input.props.onKeyDown({ key: "Enter", preventDefault() {} }),
  );
  await flush();
  expect(session.renameMeeting).toHaveBeenCalledWith(
    record.meeting.id,
    "Nabídka – Novák",
  );

  // One primary action; destructive ones only in the menu.
  await act(async () => button(root, "Zeptat se").props.onClick());
  expect(mockNavigate).toHaveBeenCalledWith({ to: "/chat" });
  const draft = readDraft(draftKey("identity-1", UNSAVED_DRAFT))!;
  expect(draft.text).toMatch(/^K schůzce „@Nabídka pro klienta“ \(.+\): $/);
  expect(draft.mentions).toEqual([
    { kind: "meeting", id: record.meeting.id, name: "Nabídka pro klienta" },
  ]);

  const items = hosts(root, "DropdownMenuItem");
  expect(items.map(text)).toEqual([
    "Kopírovat jako Markdown",
    "Stáhnout přepis .txt",
    "Smazat nahrávku zvuku",
    "Smazat",
  ]);
  await act(async () => items[0]!.props.onSelect());
  await flush();
  const markdown = (writeText.mock.calls[0] as unknown as [string])[0];
  expect(markdown).toContain("# Nabídka pro klienta");
  expect(markdown).toContain("## Rozhodnutí");
  expect(markdown).toContain("- [ ] Domluvit další schůzku — Já, pátek (0:12)");
  expect(markdown).toContain("0:05 Já: Pošlu ji do pátku.");
  expect(text(root)).toContain("Zkopírováno");
  // Where the browser takes a pending item, the write starts within the
  // click (Safari needs that) and the text follows once loaded.
  class FakeItem {
    constructor(readonly items: Record<string, Promise<Blob>>) {}
  }
  Object.defineProperty(globalThis, "ClipboardItem", {
    value: FakeItem,
    configurable: true,
  });
  const write = jest.fn(async (_items: FakeItem[]) => {});
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText, write } },
    configurable: true,
  });
  let selected: Promise<void> | undefined;
  act(() => {
    selected = items[0]!.props.onSelect();
  });
  expect(write).toHaveBeenCalledTimes(1);
  await act(async () => selected);
  const blob = await write.mock.calls[0]![0][0]!.items["text/plain"]!;
  expect(await blob.text()).toContain("# Nabídka pro klienta");
  expect(writeText).toHaveBeenCalledTimes(1);
  // A refused write says so plainly.
  write.mockRejectedValueOnce(new Error("NotAllowedError"));
  await act(async () => items[0]!.props.onSelect());
  await flush();
  expect(text(root)).toContain("Zkopírovat se nepovedlo. Zkus to znovu.");
  delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;

  const audio = hosts(root, "ConfirmAction").find(
    (node) => node.props.title === "Smazat nahrávku zvuku?",
  )!;
  await act(async () => audio.props.onConfirm());
  await flush();
  expect(session.deleteMeetingAudio).toHaveBeenCalledWith(record.meeting.id);
});

test("a meeting without turns keeps the minute transcript; deleted audio hides the player", async () => {
  const { record, segments } = twoTrack();
  const session = detailSession(
    {
      ...record,
      meeting: {
        ...record.meeting,
        audioDeletedAt: "2026-10-20T10:00:00.000Z",
        consent: { at: "2026-10-08T09:59:00.000Z", by: "TEST-user" },
      },
    },
    segments,
  );
  const renderer = await render(
    <MeetingDetail
      session={session as unknown as ClientSession}
      id={record.meeting.id}
    />,
  );
  const root = renderer.root;
  expect(text(root)).toContain("Pošlete nám prosím nabídku.");
  expect(text(root)).not.toContain("Bez potvrzení souhlasu");
  expect(() => button(root, "Přehrát")).toThrow();
  expect(hosts(root, "DropdownMenuItem").map(text)).not.toContain(
    "Smazat nahrávku zvuku",
  );
});

test("the list searches names, summaries and transcripts on the server and shows open tasks", async () => {
  {
    const ready = meeting({ title: "Porada", durationSeconds: 600 });
    const other = meeting({
      id: "22222222-2222-4222-8222-222222222222",
      title: "Klient",
    });
    const readMeetings = jest.fn(async (options: { query?: string } = {}) => ({
      profile: MEETING_PROFILE,
      scope,
      meetings: options.query ? [other] : [ready, other],
      openTasks: { [ready.id]: 2 },
      ...(options.query
        ? {
            matches: [
              {
                meetingId: other.id,
                field: "transcript" as const,
                snippet: "…pošleme ceník zítra…",
                at: 125,
              },
            ],
          }
        : {}),
    }));
    mockSession = {
      identityKey: "identity-1",
      readMeetings,
    } as unknown as ClientSession;
    const renderer = await render(<MeetingsPage />);
    const root = renderer.root;
    expect(readMeetings).toHaveBeenCalledWith(
      expect.objectContaining({ openTasks: true }),
    );
    expect(text(root)).toContain("2 úkoly");
    // Ready meetings carry no badge.
    expect(hosts(root, "StatusBadge")).toHaveLength(0);
    const search = hosts(root, "SearchField")[0]!;
    await act(async () => search.props.onChange("ceník"));
    // The server is asked once typing settles.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await flush();
    expect(readMeetings).toHaveBeenCalledWith(
      expect.objectContaining({ query: "ceník" }),
    );
    const links = root
      .findAll((node) => node.type === "a")
      .filter((node) => node.props.href?.startsWith("/meetings/"));
    expect(links.map((link) => link.props.href)).toEqual([
      `/meetings/${other.id}`,
    ]);
    expect(text(root.findByProps({ "data-testid": "meeting-match" }))).toBe(
      "2:05 …pošleme ceník zítra…",
    );
  }
});

test("the list polls only while a meeting is uploading or processing", () => {
  expect(meetingsRefetchInterval([meeting({ status: "ready" })])).toBe(false);
  expect(meetingsRefetchInterval([meeting({ status: "failed" })])).toBe(false);
  expect(meetingsRefetchInterval(undefined)).toBe(false);
  for (const status of ["uploading", "transcribing", "analyzing"] as const)
    expect(meetingsRefetchInterval([meeting({ status })])).toBe(5000);
});

test("recording starts only after the person confirms the others know", async () => {
  const store = new MeetingCaptureStore({
    uuid: () => "8a4b8f0e-5d0c-4a52-9b0e-1f2d3c4b5a69",
    now: () => Date.UTC(2026, 9, 1),
  } as CapturePorts);
  const start = jest.spyOn(store, "start").mockResolvedValue(undefined);
  const session = {
    identityKey: "identity-1",
    userId: "TEST-user",
  } as unknown as ClientSession;
  const renderer = await render(
    <MeetingCaptureActions
      session={session}
      store={store}
      onUploaded={jest.fn()}
    />,
  );
  const root = renderer.root;
  const microphone = () =>
    hosts(root, "DropdownMenuItem").find((node) =>
      text(node).startsWith("Mikrofon"),
    )!;
  expect(microphone().props.disabled).toBe(true);
  await act(async () => microphone().props.onSelect());
  expect(start).not.toHaveBeenCalled();
  const consent = hosts(root, "DropdownMenuCheckboxItem")[0]!;
  expect(text(consent)).toBe("Ostatní vědí, že nahrávám");
  await act(async () => consent.props.onCheckedChange(true));
  expect(microphone().props.disabled).toBe(false);
  await act(async () => microphone().props.onSelect());
  expect(start).toHaveBeenCalledWith(
    "microphone",
    "identity-1",
    "cs",
    expect.stringContaining("·"),
    { at: expect.any(String), by: "TEST-user" },
  );
  // Asked again for the next recording.
  expect(hosts(root, "DropdownMenuCheckboxItem")[0]!.props.checked).toBe(false);
});

test("a transcript in five-minute pieces reads as one text cut at sentences", () => {
  const sentence = (n: number) => `Věta číslo ${n} o rozpočtu obce.`;
  const piece = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => sentence(from + i)).join(" ");
  const blocks = transcriptBlocks([
    // A piece boundary falls inside a sentence.
    { start: 0, end: 300, speaker: "unknown", text: piece(1, 20) + " A pak" },
    {
      start: 300,
      end: 600,
      speaker: "unknown",
      text: "jsme hlasovali. " + piece(21, 20),
    },
    { start: 600, end: 610, speaker: "self", text: "Souhlasím." },
  ]);
  expect(blocks.map((b) => b.speaker)).toEqual(["unknown", "self"]);
  const text = blocks[0]!.paragraphs.map((p) => p.text).join(" ");
  expect(text).toContain("A pak jsme hlasovali.");
  // Paragraphs end at a sentence, and their times grow through the pieces.
  for (const paragraph of blocks[0]!.paragraphs)
    expect(paragraph.text).toMatch(/[.!?…]$/);
  const starts = blocks[0]!.paragraphs.map((p) => p.start);
  expect(starts[0]).toBe(0);
  expect(starts.at(-1)!).toBeGreaterThan(300);
  expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  expect(paragraphAt(blocks, 605)).toEqual([1, 0]);
});
