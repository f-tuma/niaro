import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DialogContent } from "../apps/server-admin/web/components/ui/dialog";
import { SheetContent } from "../apps/server-admin/web/components/ui/sheet";
import {
  Tooltip,
  TooltipProvider,
} from "../apps/server-admin/web/components/ui/tooltip";
import {
  ToastProvider,
  useToast,
  type Toast,
} from "../apps/server-admin/web/components/ui/toast";

// Radix parts as plain hosts carrying their props: these tests check what
// the app's components hand to Radix, not Radix itself.
jest.mock("radix-ui", () => {
  const { hostModule } = jest.requireActual<
    typeof import("./helpers/web-hosts")
  >("./helpers/web-hosts");
  return {
    Dialog: hostModule(),
    Tooltip: hostModule(),
  };
});
jest.mock(
  "@admin/components/ui/button",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);

const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}
const slot = (root: ReactTestInstance, name: string) =>
  root.find(
    (node) => typeof node.type === "string" && node.props["data-slot"] === name,
  );

describe("dialog and sheet widths are named by their job", () => {
  test.each([
    [undefined, "default", "data-[size=default]:sm:max-w-sm"],
    ["form", "form", "data-[size=form]:sm:max-w-md"],
    ["wide", "wide", "data-[size=wide]:sm:max-w-xl"],
    ["full", "full", "data-[size=full]:sm:max-w-5xl"],
  ] as const)("DialogContent size=%s", (size, named, width) => {
    const root = render(
      <DialogContent size={size}>
        <p>Body</p>
      </DialogContent>,
    ).root;
    const content = slot(root, "dialog-content");
    expect(content.props["data-size"]).toBe(named);
    expect(content.props.className.split(" ")).toContain(width);
    // Below the breakpoint every dialog leaves 16 px on each side.
    expect(content.props.className.split(" ")).toContain(
      "max-w-[calc(100%-2rem)]",
    );
  });

  test.each([
    [undefined, "default", []],
    ["form", "form", ["data-[size=form]:data-[side=right]:sm:max-w-md"]],
    ["wide", "wide", ["data-[size=wide]:data-[side=right]:sm:max-w-xl"]],
  ] as const)("SheetContent size=%s", (size, named, widths) => {
    const root = render(<SheetContent size={size}>Body</SheetContent>).root;
    const content = slot(root, "sheet-content");
    expect(content.props["data-size"]).toBe(named);
    for (const width of widths)
      expect(content.props.className.split(" ")).toContain(width);
  });

  // The grip is a phone bottom-sheet exit; side panels on wider screens
  // close with their own buttons, Escape or the overlay.
  test("SheetContent hides the grip on side panels from sm up", () => {
    const root = render(<SheetContent>Body</SheetContent>).root;
    expect(slot(root, "sheet-content").props.className.split(" ")).toContain(
      "group/sheet",
    );
    const grip = slot(root, "sheet-dismiss").props.className.split(" ");
    expect(grip).toContain("sm:group-data-[side=right]/sheet:hidden");
    expect(grip).toContain("sm:group-data-[side=left]/sheet:hidden");
    expect(grip.some((name: string) => name.includes("side=bottom"))).toBe(
      false,
    );
  });

  // The named sizes replace every ad-hoc width at the call sites.
  test("no page sets a dialog's or a sheet's width itself", () => {
    const web = join(__dirname, "../apps/server-admin/web");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (path !== join(web, "components/ui")) walk(path);
        } else if (name.endsWith(".tsx")) files.push(path);
      }
    };
    walk(web);
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/<(Dialog|Sheet)Content\b/g)) {
        // The opening tag ends at the first ">" outside braces.
        let depth = 0;
        let end = match.index!;
        for (; end < source.length; end++) {
          const char = source[end];
          if (char === "{") depth++;
          else if (char === "}") depth--;
          else if (char === ">" && depth === 0) break;
        }
        const tag = source.slice(match.index, end);
        if (/max-w-|size="lg"/.test(tag))
          offenders.push(
            `${file.slice(web.length + 1)}: ${tag.split("\n")[0]}`,
          );
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("tooltips wait for a resting pointer", () => {
  test("an icon button's label after 300 ms, a truncated name after 800 ms", () => {
    const root = render(
      <TooltipProvider>
        <Tooltip>action</Tooltip>
        <Tooltip delay="name">name</Tooltip>
        <Tooltip delayDuration={0}>own</Tooltip>
      </TooltipProvider>,
    ).root;
    const provider = slot(root, "tooltip-provider");
    expect(provider.props.delayDuration).toBe(300);
    // Moving on to the next trigger skips the wait.
    expect(provider.props.skipDelayDuration).toBe(300);
    const tips = root.findAll(
      (node) =>
        typeof node.type === "string" && node.props["data-slot"] === "tooltip",
    );
    expect(tips.map((tip) => [text(tip), tip.props.delayDuration])).toEqual([
      ["action", 300],
      ["name", 800],
      ["own", 0],
    ]);
  });
});

describe("the one toast says Copied or offers Undo", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  function mount() {
    const api: { current: Toast | null } = { current: null };
    function Probe() {
      api.current = useToast();
      return null;
    }
    const renderer = render(
      <ToastProvider labels={{ copied: "Zkopírováno", undo: "Zpět" }}>
        <Probe />
      </ToastProvider>,
    );
    const region = () =>
      renderer.root.find(
        (node) =>
          typeof node.type === "string" &&
          node.props["data-slot"] === "toast-region",
      );
    return { api, region, renderer };
  }

  test("Copied is read out in an always present status region and leaves", () => {
    const { api, region } = mount();
    expect(region().props.role).toBe("status");
    expect(region().props["aria-live"]).toBe("polite");
    expect(text(region())).toBe("");
    act(() => api.current!.copied());
    expect(text(region())).toBe("Zkopírováno");
    act(() => jest.advanceTimersByTime(2000));
    expect(text(region())).toBe("");
  });

  test("Undo takes the change back once and closes the toast", () => {
    const { api, region } = mount();
    const onUndo = jest.fn();
    act(() => api.current!.undo("Chat je v archivu", onUndo));
    const undo = region().find((node) => node.props["data-host"] === "Button");
    expect(text(undo)).toBe("Zpět");
    act(() => undo.props.onClick());
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(text(region())).toBe("");
  });

  test("one at a time: a new toast replaces the one shown; hovering holds it", () => {
    const { api, region } = mount();
    act(() => api.current!.undo("Chat je v archivu", () => {}));
    act(() => api.current!.copied());
    expect(text(region())).toBe("Zkopírováno");
    const toast = () =>
      region().find(
        (node) =>
          typeof node.type === "string" && node.props["data-slot"] === "toast",
      );
    act(() => toast().props.onMouseEnter());
    act(() => jest.advanceTimersByTime(10_000));
    expect(text(region())).toBe("Zkopírováno");
    act(() => toast().props.onMouseLeave());
    act(() => jest.advanceTimersByTime(2000));
    expect(text(region())).toBe("");
  });

  test("outside the app's shell there is no toast to raise", () => {
    const seen: (Toast | null)[] = [];
    function Probe() {
      seen.push(useToast());
      return null;
    }
    render(<Probe />);
    expect(seen).toEqual([null]);
  });
});
