import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ClientSession } from "../packages/client-core/session";
import {
  SKILLS_PROFILE,
  type Skill,
  type SkillList,
  type SkillProposalResult,
} from "../packages/protocol/skills";
import { SkillProposalView } from "../apps/server-admin/web/app/skill-proposal-card";
import { SkillEditor } from "../apps/server-admin/web/skill-editor";
import { SkillsPage } from "../apps/server-admin/web/app/skills-page";
import { skillsCopy } from "../apps/server-admin/web/skills-copy";

const mockApi = jest.fn();
jest.mock("../apps/server-admin/web/lib/api", () => ({
  api: (...args: unknown[]) => mockApi(...args),
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    constructor(mockStatus: number, mockCode?: string) {
      super(String(mockStatus));
      this.status = mockStatus;
      this.code = mockCode;
    }
  },
}));
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
let mockAdmin = false;
jest.mock("../apps/server-admin/web/app/context", () => ({
  useApp: () => ({
    language: "cs",
    isAdmin: mockAdmin,
    workspace: { organizationId: "org-1", workspaceId: "ws-1" },
  }),
}));
const host = () =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule();
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/badge", () => host(), { virtual: true });
jest.mock("@admin/components/ui/card", () => host(), { virtual: true });
jest.mock("@admin/components/ui/alert", () => host(), { virtual: true });
jest.mock("@admin/components/ui/spinner", () => host(), { virtual: true });
jest.mock("@admin/components/ui/skeleton", () => host(), { virtual: true });
jest.mock("@admin/components/ui/input", () => host(), { virtual: true });
jest.mock("@admin/components/ui/textarea", () => host(), { virtual: true });
jest.mock("@admin/components/ui/switch", () => host(), { virtual: true });
jest.mock("@admin/components/ui/field", () => host(), { virtual: true });
jest.mock("@admin/components/ui/tabs", () => host(), { virtual: true });
jest.mock("@admin/components/ui/dropdown-menu", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/ui/empty", () => host(), { virtual: true });
jest.mock("@admin/components/ui/item", () => host(), { virtual: true });
jest.mock("@admin/components/console/page", () => host(), { virtual: true });
jest.mock("@admin/components/console/entity-icon", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/status", () => host(), { virtual: true });
jest.mock("@admin/components/console/disclosure", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/forms", () => host(), { virtual: true });
jest.mock(
  "@admin/components/ui/markdown",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return {
      Markdown: ({ text }: { text: string }) =>
        React.createElement("div", { "data-host": "Markdown" }, text),
    };
  },
  { virtual: true },
);

const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const button = (root: ReactTestInstance, label: string) => {
  const found = root.findAll(
    (node) => node.type === "button" && text(node).includes(label),
  );
  if (!found.length) throw new Error(`No button "${label}"`);
  return found[0]!;
};
const hasButton = (root: ReactTestInstance, label: string) =>
  root.findAll((node) => node.type === "button" && text(node).includes(label))
    .length > 0;
const flush = () => act(async () => {});
async function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

const proposal: SkillProposalResult = {
  type: "skill.proposal",
  version: 1,
  proposalId: "proposal-1",
  name: "Nabídky",
  description: "Když píšeš nabídku zákazníkovi",
  preview: "# Postup\n\n1. Ceník",
  files: ["cenik.csv"],
  workspaceAllowed: false,
};
function proposalSession(saved = false) {
  const status = (target: "personal" | "workspace") => ({
    profile: SKILLS_PROFILE,
    proposalId: "proposal-1",
    status: "saved" as const,
    target,
    skillId: "skill-1",
  });
  const session = {
    readSkillProposal: jest.fn(async () =>
      saved
        ? status("personal")
        : { profile: SKILLS_PROFILE, proposalId: "proposal-1", status: "open" },
    ),
    acceptSkillProposal: jest.fn(
      async (_id: string, target: "personal" | "workspace") => status(target),
    ),
  };
  return { session: session as unknown as ClientSession, fake: session };
}

test("a skill drafted in chat is saved only by the person's click, once", async () => {
  const { session, fake } = proposalSession();
  const renderer = await render(
    <SkillProposalView
      session={session}
      proposal={proposal}
      disabled={false}
    />,
  );
  await flush();
  const root = renderer.root;
  expect(text(root)).toContain("Nabídky");
  expect(text(root)).toContain("Když píšeš nabídku zákazníkovi");
  expect(text(root)).toContain("cenik.csv");
  // Members get no company option.
  expect(hasButton(root, "Uložit pro firmu")).toBe(false);
  expect(fake.acceptSkillProposal).not.toHaveBeenCalled();
  await act(async () => button(root, "Uložit").props.onClick());
  expect(fake.acceptSkillProposal).toHaveBeenCalledWith(
    "proposal-1",
    "personal",
  );
  expect(text(root)).toContain("Uloženo do tvých skillů");
  expect(
    root.findAll(
      (node) => node.type === "a" && node.props.href === "/skills/skill-1",
    ),
  ).toHaveLength(1);
  expect(hasButton(root, "Uložit")).toBe(false);
});

test("administrators may save it for the company; an earlier save shows as saved", async () => {
  const admin = proposalSession();
  const renderer = await render(
    <SkillProposalView
      session={admin.session}
      proposal={{ ...proposal, workspaceAllowed: true }}
      disabled={false}
    />,
  );
  await flush();
  await act(async () =>
    button(renderer.root, "Uložit pro firmu").props.onClick(),
  );
  expect(admin.fake.acceptSkillProposal).toHaveBeenCalledWith(
    "proposal-1",
    "workspace",
  );
  expect(text(renderer.root)).toContain("Uloženo do firemních skillů");

  const earlier = proposalSession(true);
  const again = await render(
    <SkillProposalView
      session={earlier.session}
      proposal={proposal}
      disabled
    />,
  );
  await flush();
  expect(text(again.root)).toContain("Uloženo do tvých skillů");
  expect(earlier.fake.acceptSkillProposal).not.toHaveBeenCalled();
});

const target = { organizationId: "org-1", workspaceId: "ws-1" };
const copy = skillsCopy.cs;
const field = (
  root: ReactTestInstance,
  type: "input" | "textarea",
  index = 0,
) => root.findAll((node) => node.type === type)[index]!;

test("a new skill is checked before saving and sent as a save command", async () => {
  mockApi.mockReset();
  const saved: Skill = {
    id: "skill-1",
    owner: { type: "user", userId: "user-1" },
    name: "Nabídky",
    description: "Když píšeš nabídku",
    instructions: "1. Ceník",
    files: [],
    enabled: true,
    revision: 1,
    createdAt: "2026-10-17T08:00:00.000Z",
    updatedAt: "2026-10-17T08:00:00.000Z",
  };
  mockApi.mockResolvedValue(saved);
  const onSaved = jest.fn();
  const renderer = await render(
    <SkillEditor
      target={target}
      copy={copy}
      owner="personal"
      onSaved={onSaved}
      onArchived={jest.fn()}
    />,
  );
  const root = renderer.root;
  const form = root.findByType("form");
  await act(async () => form.props.onSubmit({ preventDefault: () => {} }));
  expect(mockApi).not.toHaveBeenCalled();
  expect(
    root.findAll((node) => node.props["data-host"] === "SaveBar")[0]!.props
      .status,
  ).toBe(copy.invalid);

  act(() =>
    field(root, "input").props.onChange({ target: { value: "Nabídky" } }),
  );
  act(() =>
    field(root, "textarea", 0).props.onChange({
      target: { value: "Když píšeš nabídku" },
    }),
  );
  act(() =>
    field(root, "textarea", 1).props.onChange({
      target: { value: "1. Ceník" },
    }),
  );
  await act(async () =>
    root.findByType("form").props.onSubmit({ preventDefault: () => {} }),
  );
  expect(mockApi).toHaveBeenCalledWith("identity/skills/command", {
    ...target,
    profile: SKILLS_PROFILE,
    type: "save",
    owner: "personal",
    revision: 0,
    content: {
      name: "Nabídky",
      description: "Když píšeš nabídku",
      instructions: "1. Ceník",
      files: [],
    },
    enabled: true,
  });
  expect(onSaved).toHaveBeenCalledWith(saved);
});

test("a company skill is read-only for members", async () => {
  const skill: Skill = {
    id: "skill-2",
    owner: { type: "workspace" },
    name: "Firemní postup",
    description: "Pro všechny",
    instructions: "# Kroky",
    files: [{ name: "sablona.md", content: "Text" }],
    enabled: true,
    revision: 3,
    createdAt: "2026-10-17T08:00:00.000Z",
    updatedAt: "2026-10-17T08:00:00.000Z",
  };
  const renderer = await render(
    <SkillEditor
      target={target}
      copy={copy}
      skill={skill}
      owner="personal"
      readOnly
      onSaved={jest.fn()}
      onArchived={jest.fn()}
    />,
  );
  const root = renderer.root;
  expect(root.findAllByType("form")).toHaveLength(0);
  expect(root.findAllByType("input")).toHaveLength(0);
  expect(text(root)).toContain("# Kroky");
  const header = root.findAll(
    (node) => node.props["data-host"] === "PageHeader",
  )[0]!;
  expect(header.props.title).toBe("Firemní postup");
  // No delete menu for someone who cannot change it.
  expect(header.props.actions).toBeUndefined();
});

test("the skills page lists mine and company skills; only admins add company ones", async () => {
  const list: SkillList = {
    profile: SKILLS_PROFILE,
    canManageWorkspace: true,
    personal: [
      {
        id: "skill-1",
        owner: { type: "user", userId: "user-1" },
        name: "Moje nabídky",
        description: "Když píšu nabídku",
        enabled: false,
        revision: 1,
        updatedAt: "2026-10-17T08:00:00.000Z",
        files: [],
      },
    ],
    workspace: [],
  };
  mockApi.mockReset();
  mockApi.mockResolvedValue(list);
  mockAdmin = true;
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: 0, retry: false } },
  });
  const renderer = await render(
    <QueryClientProvider client={client}>
      <SkillsPage />
    </QueryClientProvider>,
  );
  const root = renderer.root;
  for (let i = 0; i < 20 && !text(root).includes("Moje nabídky"); i++)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(mockApi).toHaveBeenCalledWith(
    "identity/skills/list",
    target,
    expect.anything(),
  );
  expect(text(root)).toContain("Moje nabídky");
  expect(text(root)).toContain(copy.off);
  const links = root
    .findAll((node) => node.type === "a")
    .map((node) => node.props.href);
  // "Add skill" sits in the page header; the empty company list offers its own.
  expect(
    root.findAll((node) => node.props["data-host"] === "PageHeader")[0]!.props
      .actions,
  ).toBeTruthy();
  expect(links).toEqual(["/skills/new-company"]);
  await act(async () =>
    root
      .findAll(
        (node) => node.type === "button" && text(node).includes("Moje nabídky"),
      )[0]!
      .props.onClick(),
  );
  expect(mockNavigate).toHaveBeenCalledWith({
    to: "/skills/$skillId",
    params: { skillId: "skill-1" },
  });
  renderer.unmount();
  client.clear();
  mockAdmin = false;
});
