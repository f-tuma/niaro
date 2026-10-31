import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PetPage } from "../apps/server-admin/web/app/pet-page";
jest.mock("../apps/server-admin/web/components/console/forms", () => ({
  MoreActions: () => null,
}));
jest.mock("../apps/server-admin/web/components/ui/dropdown-menu", () => ({
  DropdownMenuItem: () => null,
}));
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
    (section) => ({ section, weight: 0 }),
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
async function mount() {
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
        <PetPage />
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
beforeEach(() => {
  global.HTMLFormElement = class {} as unknown as typeof HTMLFormElement;
  mockApi.mockReset();
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
test("authenticated profile and paged private manager read without a chat session", async () => {
  const view = await mount();
  expect(mockApi.mock.calls[0][0]).toContain(
    "identity/pet?organizationId=org&workspaceId=ws&profile=work-pet%2F1",
  );
  expect(
    view.root.findAllByProps({ role: "tab" }).map((t) => t.children.join("")),
  ).toEqual(["Observed", "Saved", "About you"]);
  await act(async () =>
    button(view, "Work").props.onClick({ currentTarget: { focus: jest.fn() } }),
  );
  expect(
    mockApi.mock.calls.some(([path]) => path.includes("section=work")),
  ).toBe(true);
  expect(
    view.root.findAllByType("h2").some((h) => h.children.join("") === "Work"),
  ).toBe(true);
  act(() => view.unmount());
});
test("appearance saves confirmed server state; a rejected write keeps the entered draft", async () => {
  const view = await mount();
  await act(async () => button(view, "Appearance").props.onClick());
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
  expect(view.root.findAllByProps({ role: "alert" }).length).toBe(1);
  act(() => view.unmount());
});

test("committed personal erasure updates renderer shape and ink without discarding appearance draft", async () => {
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
              })),
            },
      );
    },
  );
  const view = await mount();
  expect(mockPet.mock.lastCall![0].appearance.shape).toBe("flower");
  await act(async () => button(view, "Appearance").props.onClick());
  act(() =>
    view.root
      .findAllByType("input")
      .find((i) => i.props.value === "Niaro")!
      .props.onChange({ target: { value: "Unsaved name" } }),
  );
  await act(async () =>
    button(view, "Drop personal observations").props.onClick(),
  );
  await act(async () =>
    view.root
      .findByType("dialog")
      .findAllByType("button")
      .at(-1)!
      .props.onClick(),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  const draftPreserved = view.root
    .findAllByType("input")
    .some((i) => i.props.value === "Unsaved name");
  await act(async () =>
    view.root.findAllByProps({ role: "tab" })[0]!.props.onClick(),
  );
  expect(mockPet.mock.lastCall![0].appearance.shape).toBe("circle");
  expect(mockPet.mock.lastCall![0].appearance.counts).toEqual([
    0, 0, 0, 0, 0, 0,
  ]);
  expect(draftPreserved).toBe(true);
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
