import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import calendar from "../apps/server-admin/web/app/widgets/calendar";
import { calendarWidget } from "../packages/protocol/widgets/calendar";
import {
  calendarDays,
  calendarEntries,
  isoDate,
  layoutDays,
} from "../apps/server-admin/web/app/widgets/calendar-model";

/*
 * The calendar widget's body on its own: day columns with an hour grid,
 * events placed by time in lanes, all-day chips, task markers, the detail
 * with its actions, and the view the person switches locally.
 */
const host = () =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule();
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/input", () => host(), { virtual: true });
jest.mock("@admin/components/ui/switch", () => host(), { virtual: true });
jest.mock("@admin/components/ui/toggle-group", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/ui/field", () => host(), { virtual: true });
jest.mock("@admin/components/ui/popover", () => host(), { virtual: true });
jest.mock("@admin/components/console/status", () => host(), { virtual: true });

type Data = ReturnType<typeof calendarWidget.sample>;
type Config = typeof calendarWidget.defaultConfig;

/** A local date-time `days` from today, without an offset. */
const at = (days: number, hour: number, minute = 0) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(hour)}:${pad(minute)}:00`;
};
const dayOf = (days: number) => at(days, 0).slice(0, 10);
const today = dayOf(0);

const data: Data = {
  events: [
    {
      title: "Porada týmu",
      start: at(0, 9),
      end: at(0, 9, 45),
      location: "Zasedačka",
      organizer: "Jana Nováková",
      attendees: ["Jana Nováková", "Petr Svoboda"],
      status: "accepted",
      description: "Ceny a termíny.",
      join: "https://teams.microsoft.com/l/meetup-join/x",
      link: "https://calendar.example/e/1",
    },
    {
      title: "Volání s dodavatelem",
      start: at(0, 9, 30),
      end: at(0, 10),
      status: "tentative",
    },
    { title: "Oběd", start: at(0, 12), end: at(0, 13) },
    {
      title: "Prezentace",
      start: at(1, 14),
      end: at(1, 15),
      status: "declined",
    },
    { title: "Veletrh", start: dayOf(2), allDay: true },
  ],
  tasks: [
    { title: "Poslat nabídku", due: at(0, 16) },
    { title: "Faktura", due: dayOf(1), done: true },
  ],
};
const config = (patch: Partial<Config> = {}): Config => ({
  ...calendarWidget.defaultConfig,
  ...patch,
});

const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const byTestId = (root: ReactTestInstance, id: string) =>
  root.findAll(
    (node) => typeof node.type === "string" && node.props["data-testid"] === id,
  );
const hostOf = (root: ReactTestInstance, name: string) =>
  root.findAll((node) => node.props["data-host"] === name);
/** The Popover around a block: its host carries open/onOpenChange. */
const popoverOf = (node: ReactTestInstance) => {
  let current: ReactTestInstance | null = node;
  while (current && current.props["data-host"] !== "Popover")
    current = current.parent;
  if (!current) throw new Error("No popover");
  return current;
};

const mounted: (() => void)[] = [];
afterEach(() => mounted.splice(0).forEach((unmount) => unmount()));
function render(
  props: Partial<React.ComponentProps<typeof calendar.Body>> & {
    config?: Config;
  } = {},
) {
  const ask = jest.fn();
  const Body = calendar.Body;
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <Body
        data={data}
        config={config()}
        item={null}
        language="cs"
        ask={ask}
        {...props}
      />,
    );
  });
  mounted.push(() => act(() => renderer.unmount()));
  return { root: renderer.root, ask };
}
const columns = (root: ReactTestInstance) =>
  byTestId(root, "calendar-day").map((node) => node.props["data-date"]);

test("the range sets the day columns: one, three, seven, or Monday to Friday", () => {
  expect(columns(render({ config: config({ range: "today" }) }).root)).toEqual([
    today,
  ]);
  expect(columns(render({ config: config({ range: "next3" }) }).root)).toEqual([
    today,
    dayOf(1),
    dayOf(2),
  ]);
  expect(columns(render({ config: config({ range: "week" }) }).root)).toEqual(
    [0, 1, 2, 3, 4, 5, 6].map(dayOf),
  );
  const workweek = columns(
    render({ config: config({ range: "workweek" }) }).root,
  );
  expect(workweek).toHaveLength(5);
  expect(new Date(`${workweek[0]}T00:00:00`).getDay()).toBe(1);
  expect(workweek).toContain(
    new Date().getDay() % 6 === 0 ? workweek[0] : today,
  );
});

test("events sit in their day by time; overlapping ones share the column in lanes", () => {
  const { root } = render({ config: config({ range: "next3" }) });
  const events = byTestId(root, "calendar-event");
  expect(
    events.map((node) => [
      node.props["data-day"],
      node.props["data-lane"],
      node.props["data-lanes"],
      node.props["data-status"],
    ]),
  ).toEqual([
    [today, 0, 2, "accepted"],
    [today, 1, 2, "tentative"],
    [today, 0, 1, "none"],
    [dayOf(1), 0, 1, "declined"],
  ]);
  // Placed on the whole day: 9:00 is nine twenty-fourths down, 45 minutes tall.
  const porada = events[0]!;
  expect(porada.props.style["--cal-top"]).toBe(`${(9 / 24) * 100}%`);
  expect(porada.props.style["--cal-height"]).toBe(`${(0.75 / 24) * 100}%`);
  expect(porada.props.style["--cal-width"]).toBe("50%");
  expect(events[1]!.props.style["--cal-left"]).toBe("50%");
  expect(text(porada)).toContain("Porada týmu");
  expect(text(porada)).toMatch(/9:00–9:45/);
  expect(text(porada)).toContain("Zasedačka");
  // Hour labels down the left, today's column marked.
  expect(text(byTestId(root, "calendar-grid")[0]!)).toContain("7:00");
  expect(text(byTestId(root, "calendar-grid")[0]!)).toContain("18:00");
  const days = byTestId(root, "calendar-day");
  expect(days.map((node) => node.props["data-today"])).toEqual([
    true,
    false,
    false,
  ]);
});

test("all-day events and date-only tasks are chips above the grid; timed tasks are markers in it", () => {
  const { root } = render({ config: config({ range: "next3" }) });
  const chips = byTestId(root, "calendar-chip");
  expect(chips.map((node) => [node.props["data-kind"], text(node)])).toEqual([
    ["task", "Faktura"],
    ["event", "Veletrh"],
  ]);
  expect(chips[0]!.props["data-done"]).toBe(true);
  const rows = byTestId(root, "calendar-allday");
  expect(rows.map((node) => node.props["data-date"])).toEqual([
    today,
    dayOf(1),
    dayOf(2),
  ]);
  expect(byTestId(rows[2]!, "calendar-chip")).toHaveLength(1);
  const tasks = byTestId(root, "calendar-task");
  expect(tasks).toHaveLength(1);
  expect(tasks[0]!.props["data-day"]).toBe(today);
  expect(tasks[0]!.props.style["--cal-top"]).toBe(`${(16 / 24) * 100}%`);
  expect(text(tasks[0]!)).toBe("Poslat nabídku");
  // Without tasks, only the events remain.
  const { root: eventsOnly } = render({
    config: config({ range: "next3", tasks: false }),
  });
  expect(byTestId(eventsOnly, "calendar-task")).toHaveLength(0);
  expect(byTestId(eventsOnly, "calendar-chip")).toHaveLength(1);
});

test("an event's detail shows where, who and the response, joins, opens and prepares in chat", () => {
  const { root, ask } = render();
  const porada = byTestId(root, "calendar-event")[0]!;
  expect(byTestId(root, "calendar-detail")).toHaveLength(0);
  act(() => popoverOf(porada).props.onOpenChange(true));
  const detail = byTestId(root, "calendar-detail")[0]!;
  expect(text(hostOf(detail, "PopoverTitle")[0]!)).toBe("Porada týmu");
  expect(text(hostOf(detail, "PopoverDescription")[0]!)).toMatch(/9:00–9:45/);
  expect(text(detail)).toContain("Zasedačka");
  expect(text(detail)).toContain("Jana Nováková, Petr Svoboda");
  expect(text(detail)).toContain("Ceny a termíny.");
  const status = hostOf(detail, "StatusBadge")[0]!;
  expect(status.props.tone).toBe("success");
  expect(text(status)).toBe("Přijato");
  const join = byTestId(detail, "calendar-join")[0]!;
  expect(join.props.href).toBe("https://teams.microsoft.com/l/meetup-join/x");
  expect(join.props.target).toBe("_blank");
  expect(join.props.rel).toBe("noreferrer");
  expect(text(join)).toContain("Připojit se");
  const open = detail.find(
    (node) => node.type === "a" && node.props["aria-label"] === "Otevřít",
  );
  expect(open.props.href).toBe("https://calendar.example/e/1");
  const prepare = byTestId(detail, "widget-ask-item")[0]!;
  expect(text(prepare)).toContain("Připrav mě na tuto schůzku");
  act(() => prepare.props.onClick());
  expect(ask).toHaveBeenCalledWith(
    expect.stringMatching(
      /^Připrav mě na schůzku „Porada týmu“ \(.*9:00–9:45, Zasedačka\)\.$/,
    ),
  );
  // A tentative event is badged so; a task asks for help instead.
  act(() =>
    popoverOf(byTestId(root, "calendar-event")[1]!).props.onOpenChange(true),
  );
  expect(hostOf(root, "StatusBadge").map((node) => node.props.tone)).toContain(
    "warning",
  );
  act(() =>
    popoverOf(byTestId(root, "calendar-task")[0]!).props.onOpenChange(true),
  );
  const help = byTestId(root, "widget-ask-item").find((node) =>
    text(node).includes("Pomoz mi s tím"),
  )!;
  act(() => help.props.onClick());
  expect(ask).toHaveBeenLastCalledWith(
    expect.stringContaining("Pomoz mi s úkolem „Poslat nabídku“"),
  );
});

test("the view switch and a day's header change what is shown without touching the config", () => {
  const { root } = render({ config: config({ range: "week" }) });
  expect(columns(root)).toHaveLength(7);
  const view = byTestId(root, "calendar-view")[0]!;
  expect(view.props.value).toBe("week");
  act(() => view.props.onValueChange("day"));
  expect(columns(root)).toEqual([today]);
  act(() => view.props.onValueChange("next3"));
  expect(columns(root)).toHaveLength(3);
  // A day's header focuses that day; back returns to the view.
  expect(byTestId(root, "calendar-back")).toHaveLength(0);
  const tomorrow = byTestId(root, "calendar-day-header")[1]!;
  expect(tomorrow.props.disabled).toBe(false);
  act(() => tomorrow.props.onClick());
  expect(columns(root)).toEqual([dayOf(1)]);
  expect(byTestId(root, "calendar-day-header")[0]!.props.disabled).toBe(true);
  act(() => byTestId(root, "calendar-back")[0]!.props.onClick());
  expect(columns(root)).toHaveLength(3);
  // A single day's range still offers the wider views.
  const { root: single } = render({ config: config({ range: "today" }) });
  expect(columns(single)).toHaveLength(1);
  act(() => byTestId(single, "calendar-view")[0]!.props.onValueChange("week"));
  expect(columns(single)).toHaveLength(7);
});

test("opened large, the calendar shows every day of the range with taller hours", () => {
  const { root } = render({
    config: config({ range: "week" }),
    expanded: true,
  });
  expect(byTestId(root, "calendar")[0]!.props["data-large"]).toBe(true);
  expect(columns(root)).toHaveLength(7);
  expect(byTestId(root, "calendar-event")).toHaveLength(4);
});

test("the large view's pane keeps its entry when a refresh reorders the events", () => {
  const Body = calendar.Body;
  const view = (events: Data["events"]) => (
    <Body
      data={{ ...data, events }}
      config={config({ range: "week" })}
      item={null}
      language="cs"
      ask={jest.fn()}
      expanded
    />
  );
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(view(data.events));
  });
  mounted.push(() => act(() => renderer.unmount()));
  const lunch = byTestId(renderer.root, "calendar-event").find((node) =>
    text(node).includes("Oběd"),
  )!;
  act(() => lunch.props.onClick());
  const pane = () => text(byTestId(renderer.root, "calendar-pane")[0]!);
  expect(pane()).toContain("Oběd");
  act(() =>
    renderer.update(
      view([{ title: "Snídaně", start: at(0, 7) }, ...data.events]),
    ),
  );
  expect(pane()).toContain("Oběd");
  expect(pane()).not.toContain("Snídaně");
});

test("the grid runs midnight to midnight whatever the working hours, and today carries the time line", () => {
  const early: Data = {
    events: [{ title: "Let", start: at(0, 5, 30), end: at(0, 6, 15) }],
    tasks: [],
  };
  const { root } = render({ data: early, config: config({ range: "today" }) });
  const grid = text(byTestId(root, "calendar-grid")[0]!);
  expect(grid.startsWith("0:00")).toBe(true);
  expect(grid).toContain("23:00");
  expect(byTestId(root, "calendar-event")[0]!.props.style["--cal-top"]).toBe(
    `${(5.5 / 24) * 100}%`,
  );
  const { root: allHours } = render({
    config: config({ dayStart: 0, dayEnd: 24 }),
  });
  expect(byTestId(allHours, "calendar-now")).toHaveLength(1);
  expect(byTestId(allHours, "calendar-day")[0]!.props["data-today"]).toBe(true);
});

test("nothing planned keeps the grid and says so once; the preview has no controls", () => {
  const { root } = render({ data: { events: [], tasks: [] } });
  expect(text(root)).toContain("Nic naplánovaného.");
  expect(byTestId(root, "calendar-day")).toHaveLength(1);
  expect(byTestId(root, "calendar-event")).toHaveLength(0);
  const { root: preview } = render({ preview: true });
  expect(byTestId(preview, "calendar-view")).toHaveLength(0);
  expect(hostOf(preview, "Popover")).toHaveLength(0);
  expect(byTestId(preview, "calendar-event")).toHaveLength(3);
});

test("the model: a date-only end of an all-day event is exclusive, tasks follow the config, lanes close when a cluster ends", () => {
  const now = new Date(`${today}T10:00:00`);
  const entries = calendarEntries(
    {
      events: [
        { title: "Konference", start: dayOf(0), end: dayOf(2), allDay: true },
        { title: "A", start: at(0, 9), end: at(0, 10) },
        { title: "B", start: at(0, 9, 30), end: at(0, 10, 30) },
        { title: "C", start: at(0, 10, 30), end: at(0, 11) },
        { title: "Bez konce", start: at(0, 14) },
      ],
      tasks: [{ title: "T", due: at(0, 12) }],
    },
    config({ range: "next3", tasks: false }),
  );
  expect(entries.map((entry) => entry.title)).toEqual([
    "Konference",
    "A",
    "B",
    "C",
    "Bez konce",
  ]);
  const days = calendarDays("next3", "next3", now);
  const layout = layoutDays(entries, days, { from: 7, to: 19 }, now);
  expect(layout.days.map((day) => day.allDay.length)).toEqual([1, 1, 0]);
  expect(
    layout.days[0]!.events.map((placed) => [
      placed.entry.title,
      placed.lane,
      placed.lanes,
      placed.endMin - placed.startMin,
    ]),
  ).toEqual([
    ["A", 0, 2, 60],
    ["B", 1, 2, 60],
    ["C", 0, 1, 30],
    ["Bez konce", 0, 1, 30],
  ]);
  expect(isoDate(layout.days[1]!.date)).toBe(dayOf(1));
});
