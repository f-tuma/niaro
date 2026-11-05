import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PetPage } from "../apps/server-admin/web/app/pet-page";
import { Disclosure } from "../apps/server-admin/web/components/console/disclosure";
jest.mock("../apps/server-admin/web/components/console/forms", () => ({
  MoreActions: ({ children }: { children: React.ReactNode }) => (
    <div data-menu>{children}</div>
  ),
}));
jest.mock("../apps/server-admin/web/components/ui/dropdown-menu", () => ({
  DropdownMenuItem: ({
    children,
    onSelect,
    asChild,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    asChild?: boolean;
  }) => (asChild ? children : <button onClick={onSelect}>{children}</button>),
  DropdownMenuSeparator: () => null,
}));
jest.mock("../apps/server-admin/web/components/ui/sheet", () => {
  const Box = ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Sheet: ({
      open,
      children,
    }: {
      open: boolean;
      children: React.ReactNode;
    }) => (open ? <div role="dialog">{children}</div> : null),
    SheetContent: Box,
    SheetHeader: Box,
    SheetFooter: Box,
    SheetTitle: ({ children }: { children: React.ReactNode }) => (
      <h2>{children}</h2>
    ),
  };
});
jest.mock("../apps/server-admin/web/components/ui/alert-dialog", () => {
  const Box = ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  );
  const Action = ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: (event: { preventDefault(): void }) => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
  return {
    AlertDialog: ({
      open,
      children,
    }: {
      open: boolean;
      children: React.ReactNode;
    }) => (open ? <div role="alertdialog">{children}</div> : null),
    AlertDialogContent: Box,
    AlertDialogHeader: Box,
    AlertDialogFooter: Box,
    AlertDialogTitle: ({ children }: { children: React.ReactNode }) => (
      <p>{children}</p>
    ),
    AlertDialogDescription: ({ children }: { children: React.ReactNode }) => (
      <p>{children}</p>
    ),
    AlertDialogAction: Action,
    AlertDialogCancel: Action,
  };
});
const mockApi = jest.fn();
const mockPet = jest.fn();
let mockOwner = "owner";
jest.mock("../apps/server-admin/web/lib/api", () => ({
  api: (...args: unknown[]) => mockApi(...args),
}));
jest.mock("../apps/server-admin/web/app/context", () => ({
  useApp: () => ({
    language: "en",
    session: null,
    workspace: { organizationId: "org", workspaceId: "ws" },
    identity: { user: { id: mockOwner } },
  }),
}));
jest.mock("../apps/server-admin/web/lib/theme", () => ({
  useTheme: () => "dark",
}));
jest.mock("../apps/server-admin/web/app/pet-view", () => ({
  WebPetView: (props: unknown) => {
    mockPet(props);
    return null;
  },
}));
jest.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("../apps/server-admin/web/app/pet-page.css", () => ({}));
const counts = [5, 3, 2, 1, 1, 0];
const profile = {
  profile: "work-pet/1",
  organizationId: "org",
  workspaceId: "ws",
  userId: "owner",
  revision: 0,
  settings: {
    name: "Niaro",
    colour: "#BDB3FA",
    shape: "cookie",
    animate: false,
    showInChat: true,
    jobTitle: "",
    department: "",
  },
  automaticShape: "circle",
  look: ["work", "projects", "tools", "people", "style", "rhythm"].map(
    (section, i) => ({ section, weight: counts[i]! / 12, count: counts[i] }),
  ),
};
const page = {
  profile: "work-pet/1",
  organizationId: "org",
  workspaceId: "ws",
  userId: "owner",
  version: 0,
  enabled: true,
  optOut: false,
  personalThings: "keep",
  items: [],
  nextCursor: null,
};
async function mount(manager = false) {
  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    view = TestRenderer.create(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
          })
        }
      >
        <PetPage manager={manager} />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  return view;
}
function button(view: TestRenderer.ReactTestRenderer, text: string) {
  return view.root
    .findAllByType("button")
    .find((b) =>
      b.children.some((c) =>
        typeof c === "string" ? c === text : c.children.join("") === text,
      ),
    )!;
}
function labelled(view: TestRenderer.ReactTestRenderer, label: string) {
  return view.root
    .findAllByType("button")
    .find((b) => b.props["aria-label"] === label)!;
}
function texts(view: TestRenderer.ReactTestRenderer, type: React.ElementType) {
  return view.root
    .findAllByType(type)
    .map((node) =>
      node.children.map((c) => (typeof c === "string" ? c : "")).join(""),
    );
}
function statusLine(view: TestRenderer.ReactTestRenderer) {
  return texts(view, "p").concat(texts(view, "span"));
}
beforeEach(() => {
  global.HTMLFormElement = class {} as unknown as typeof HTMLFormElement;
  mockApi.mockReset();
  mockPet.mockReset();
  mockOwner = "owner";
  mockApi.mockImplementation((url: string) =>
    Promise.resolve(url.includes("/memory?") ? page : profile),
  );
  global.crypto = { randomUUID: () => "request-1" } as unknown as Crypto;
  global.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  };
});
test("the screen counts work observations from look[].count and an icon toggles its section", async () => {
  const view = await mount();
  expect(mockApi.mock.calls[0][0]).toContain(
    "identity/pet?organizationId=org&workspaceId=ws&profile=work-pet%2F1",
  );
  expect(statusLine(view)).toContain("Knows 12 work things");
  const toolbar = view.root.findByProps({ role: "toolbar" });
  expect(
    toolbar.findAllByType("button").map((b) => b.props["aria-label"]),
  ).toEqual([
    "Work · 5 observations",
    "Projects · 3 observations",
    "Tools · 2 observations",
    "People · 1 observation",
    "Style · 1 observation",
    "Rhythm · 0 observations",
  ]);
  // A tile is icon, count (only above zero) and label.
  expect(
    toolbar.findAllByType("button").map((b) => {
      const count = b.children.find(
        (c) =>
          typeof c !== "string" &&
          String(c.props.className).includes("tabular-nums"),
      );
      return count && typeof count !== "string"
        ? Number(count.children.join(""))
        : null;
    }),
  ).toEqual([5, 3, 2, 1, 1, null]);
  const focus = jest.fn();
  const work = labelled(view, "Work · 5 observations");
  await act(async () => work.props.onClick({ currentTarget: { focus } }));
  expect(
    mockApi.mock.calls.some(([path]) => path.includes("section=work")),
  ).toBe(true);
  expect(texts(view, "h2")).toContain("Work");
  expect(labelled(view, "Work · 5 observations").props["aria-pressed"]).toBe(
    true,
  );
  expect(mockPet.mock.lastCall![0].size).toBe(160);
  await act(async () =>
    labelled(view, "Work · 5 observations").props.onClick({
      currentTarget: { focus },
    }),
  );
  expect(texts(view, "h2")).not.toContain("Work");
  expect(focus).toHaveBeenCalled();
  expect(mockPet.mock.lastCall![0].size).toBe(280);
  act(() => view.unmount());
});
test("memory off puts the pet to rest with an honest status; an unavailable plugin disables the light", async () => {
  mockApi.mockImplementation((url: string) =>
    Promise.resolve(
      url.includes("/memory?") ? { ...page, optOut: true } : profile,
    ),
  );
  const asleep = await mount();
  expect(statusLine(asleep)).toContain("Memory asleep");
  expect(mockPet.mock.lastCall![0].state).toBe("resting");
  const light = asleep.root
    .findAllByProps({ "aria-label": "Use memory" })
    .find((node) => typeof node.props.onCheckedChange === "function")!;
  expect(light.props.checked).toBe(false);
  expect(light.props.disabled).toBe(false);
  act(() => asleep.unmount());
  mockApi.mockImplementation((url: string) =>
    Promise.resolve(
      url.includes("/memory?") ? { ...page, enabled: false } : profile,
    ),
  );
  const off = await mount();
  expect(statusLine(off)).toContain("Memory unavailable");
  expect(mockPet.mock.lastCall![0].state).toBe("resting");
  expect(
    off.root
      .findAllByProps({ "aria-label": "Use memory" })
      .find((node) => typeof node.props.onCheckedChange === "function")!.props
      .disabled,
  ).toBe(true);
  act(() => off.unmount());
});
test("an empty profile says it is still learning", async () => {
  mockApi.mockImplementation((url: string) =>
    Promise.resolve(
      url.includes("/memory?")
        ? page
        : {
            ...profile,
            look: profile.look.map((item) => ({
              ...item,
              weight: 0,
              count: 0,
            })),
          },
    ),
  );
  const view = await mount();
  expect(statusLine(view)).toContain("Still learning you");
  expect(mockPet.mock.lastCall![0].state).toBe("idle");
  act(() => view.unmount());
});
test("About you lists what Niaro never learns in a closed disclosure (NIAR-272)", async () => {
  const view = await mount();
  await act(async () => button(view, "About you").props.onClick());
  const [boundary] = view.root
    .findAllByType(Disclosure)
    .filter((node) => node.props.title === "What Niaro never learns");
  expect(boundary).toBeDefined();
  expect(boundary!.props.defaultOpen).toBeUndefined();
  expect(boundary!.props.open).toBeUndefined();
  // Closed: the list is not rendered until the person opens it.
  expect(boundary!.findAllByType("p")).toHaveLength(0);
  const text = [boundary!.props.children.props.children].flat().join("");
  for (const category of ["Health", "trade union membership", "passwords"])
    expect(text).toContain(category);
  expect(text).toContain("If something slips through, delete it.");
  act(() => view.unmount());
});
test("appearance saves confirmed server state; a rejected write keeps the entered draft", async () => {
  const view = await mount();
  await act(async () => button(view, "Appearance").props.onClick());
  expect(texts(view, "h2")).toContain("Appearance");
  const swatches = view.root.findAllByProps({ role: "radio" });
  expect(swatches.map((s) => s.props["aria-label"])).toEqual([
    "Lavender",
    "Mint",
    "Peach",
    "Sky",
    "Lemon",
    "Rose",
    "Sage",
    "Mist",
  ]);
  const name = view.root
    .findAllByType("input")
    .find((i) => i.props.value === "Niaro")!;
  act(() => name.props.onChange({ target: { value: "Edited" } }));
  mockApi.mockImplementation((url: string, body: unknown) =>
    body
      ? Promise.reject(Error("pet_conflict"))
      : Promise.resolve(url.includes("/memory?") ? page : profile),
  );
  await act(async () =>
    view.root.findByType("form").props.onSubmit({ preventDefault: () => {} }),
  );
  expect(
    view.root.findAllByType("input").some((i) => i.props.value === "Edited"),
  ).toBe(true);
  expect(mockApi.mock.calls.filter(([, body]) => body).length).toBe(1);
  // The unconfirmed save asks in a dialog, not in an inline alert.
  expect(view.root.findAllByProps({ role: "alert" }).length).toBe(0);
  expect(view.root.findAllByProps({ role: "alertdialog" }).length).toBe(1);
  act(() => view.unmount());
});

test("/me/memory shows the saved list, the keep switch and a confirmed erase", async () => {
  const view = await mount(true);
  expect(texts(view, "h2")).toContain("Saved");
  expect(
    mockApi.mock.calls.some(([path]) => path.includes("origin=explicit")),
  ).toBe(true);
  const keep = view.root
    .findAllByProps({ "aria-label": "Keep personal observations" })
    .find((node) => typeof node.props.onCheckedChange === "function")!;
  expect(keep.props.checked).toBe(true);
  expect(view.root.findAllByProps({ role: "alertdialog" }).length).toBe(0);
  await act(async () => button(view, "Delete").props.onClick());
  const dialog = view.root.findByProps({ role: "alertdialog" });
  expect(texts(view, "p")).toContain(
    "Erase private memories and all earlier versions? Chats and meetings remain.",
  );
  const sent = mockApi.mock.calls.length;
  await act(async () =>
    dialog
      .findAllByType("button")
      .at(-1)!
      .props.onClick({ preventDefault: () => {} }),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(
    mockApi.mock.calls
      .slice(sent)
      .some(([, body]) => (body as { type?: string })?.type === "forgetAll"),
  ).toBe(true);
  expect(view.root.findAllByProps({ role: "alertdialog" }).length).toBe(0);
  // The closed dialog is the confirmation; "Saved" is for screen readers only.
  const saved = view.root.findByProps({ role: "status" });
  expect(saved.children).toEqual(["Saved"]);
  expect(saved.props.className).toBe("sr-only");
  act(() => view.unmount());
});

test("a saved appearance closes its sheet and shows no toast (NIAR-278)", async () => {
  const view = await mount();
  await act(async () => button(view, "Appearance").props.onClick());
  const name = view.root
    .findAllByType("input")
    .find((i) => i.props.value === "Niaro")!;
  act(() => name.props.onChange({ target: { value: "Edited" } }));
  mockApi.mockImplementation((url: string, body: unknown) =>
    Promise.resolve(
      body
        ? {
            ...profile,
            revision: 1,
            settings: { ...profile.settings, name: "Edited" },
          }
        : url.includes("/memory?")
          ? page
          : profile,
    ),
  );
  await act(async () =>
    view.root.findByType("form").props.onSubmit({ preventDefault: () => {} }),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  // The form is gone: the sheet closed on the confirmed save.
  expect(view.root.findAllByType("form").length).toBe(0);
  const status = view.root.findByProps({ role: "status" });
  expect(status.children).toEqual(["Saved"]);
  expect(status.props.className).toBe("sr-only");
  // Nothing floats over the page.
  expect(
    view.root.findAll(
      (node) =>
        typeof node.type === "string" &&
        String(node.props.className ?? "").includes("fixed"),
    ),
  ).toHaveLength(0);
  act(() => view.unmount());
});

test("committed personal erasure on /me/memory updates renderer shape and ink", async () => {
  let erased = false;
  mockApi.mockImplementation(
    (url: string, body: { type?: string } | undefined) => {
      if (body?.type === "personalThings") erased = true;
      return Promise.resolve(
        url.includes("/memory?")
          ? { ...page, personalThings: erased ? "drop" : "keep" }
          : {
              ...profile,
              settings: { ...profile.settings, shape: "auto" },
              automaticShape: erased ? "circle" : "flower",
              look: profile.look.map((item) => ({
                ...item,
                weight: erased ? 0 : 0.8,
                count: erased ? 0 : 8,
              })),
            },
      );
    },
  );
  const view = await mount(true);
  expect(mockPet.mock.lastCall![0].appearance.shape).toBe("flower");
  const keep = view.root
    .findAllByProps({ "aria-label": "Keep personal observations" })
    .find((node) => typeof node.props.onCheckedChange === "function")!;
  await act(async () => keep.props.onCheckedChange(false));
  const dialog = view.root.findByProps({ role: "alertdialog" });
  expect(texts(view, "p")).toContain(
    "Erase all personal observations and their earlier versions? Explicitly saved memories remain.",
  );
  await act(async () =>
    dialog
      .findAllByType("button")
      .at(-1)!
      .props.onClick({ preventDefault: () => {} }),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(mockPet.mock.lastCall![0].appearance.shape).toBe("circle");
  expect(mockPet.mock.lastCall![0].appearance.counts).toEqual([
    0, 0, 0, 0, 0, 0,
  ]);
  expect(
    view.root
      .findAllByProps({ "aria-label": "Keep personal observations" })
      .find((node) => typeof node.props.onCheckedChange === "function")!.props
      .checked,
  ).toBe(false);
  act(() => view.unmount());
});

test("a late committed memory response cannot refresh or replace another owner", async () => {
  let finish!: (value: unknown) => void;
  mockApi.mockImplementation((url: string, body: unknown) => {
    if (body)
      return new Promise((resolve) => {
        finish = resolve;
      });
    return Promise.resolve(
      url.includes("/memory?")
        ? { ...page, userId: mockOwner }
        : { ...profile, userId: mockOwner },
    );
  });
  const old = await mount();
  const toggle = old.root
    .findAllByProps({ "aria-label": "Use memory" })
    .find((node) => typeof node.props.onCheckedChange === "function")!;
  act(() => {
    toggle.props.onCheckedChange(false);
  });
  expect(old.root.findByProps({ role: "status" }).children).toEqual([]);
  act(() => old.unmount());
  mockOwner = "next-owner";
  const current = await mount();
  const calls = mockApi.mock.calls.length;
  await act(async () => {
    finish({ ...page, optOut: true });
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(mockApi.mock.calls.length).toBe(calls);
  expect(current.root.findByProps({ role: "status" }).children).toEqual([]);
  expect(mockPet.mock.lastCall![0].appearance.shape).toBe("cookie");
  act(() => current.unmount());
});

test("About you and /me/memory export the person's memory as Markdown or JSON with plain links (NIAR-297)", async () => {
  for (const manager of [false, true]) {
    const view = await mount(manager);
    const links = view.root.findAll(
      (node) => node.type === "a" && node.props.download === true,
    );
    expect(
      links.map((link) =>
        link.children.map((c) => (typeof c === "string" ? c : "")).join(""),
      ),
    ).toEqual(["Export as Markdown", "Export as JSON"]);
    expect(links.map((link) => link.props.href)).toEqual([
      "/admin/api/identity/memory/export?organizationId=org&workspaceId=ws&format=md&lang=en",
      "/admin/api/identity/memory/export?organizationId=org&workspaceId=ws&format=json&lang=en",
    ]);
    // Both sit in the page's … menu, nowhere else.
    for (const link of links)
      expect(
        (() => {
          for (let node = link.parent; node; node = node.parent)
            if (node.props["data-menu"]) return true;
          return false;
        })(),
      ).toBe(true);
    act(() => view.unmount());
  }
});
