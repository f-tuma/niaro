import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { webcrypto } from "node:crypto";
import type { ClientSession } from "../packages/client-core/session";
import {
  PROCESS_PROPOSAL_PROFILE,
  ProcessProposalResultSchema,
  type ProcessProposalResult,
  type ProcessProposalStatus,
} from "../packages/protocol/process-proposal";
import { ProcessProposalView } from "../apps/server-admin/web/app/chat-cards";

if (!globalThis.crypto?.randomUUID)
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });

jest.mock("@tanstack/react-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    Link: ({
      to,
      params,
      search,
      ...props
    }: React.ComponentProps<"a"> & {
      to: string;
      params?: Record<string, string>;
      search?: Record<string, string>;
    }) =>
      React.createElement("a", {
        ...props,
        href:
          Object.entries(params ?? {}).reduce(
            (path, [key, value]) => path.replace(`$${key}`, value),
            to,
          ) + (search ? "?" + new URLSearchParams(search).toString() : ""),
      }),
    useNavigate: () => jest.fn(),
    useParams: () => ({}),
  };
});
let mockAdmin = false;
jest.mock("../apps/server-admin/web/app/context", () => ({
  useApp: () => ({ language: "cs", isAdmin: mockAdmin }),
}));
const host = () =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule();
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/card", () => host(), { virtual: true });
jest.mock("@admin/components/ui/alert", () => host(), { virtual: true });
jest.mock("@admin/components/ui/badge", () => host(), { virtual: true });
jest.mock("@admin/components/ui/checkbox", () => host(), { virtual: true });
jest.mock("@admin/components/ui/field", () => host(), { virtual: true });
jest.mock("@admin/components/ui/spinner", () => host(), { virtual: true });
jest.mock("@admin/components/ui/label", () => host(), { virtual: true });
jest.mock("@admin/components/ui/input", () => host(), { virtual: true });
jest.mock("@admin/components/ui/switch", () => host(), { virtual: true });
jest.mock("@admin/components/ui/progress", () => host(), { virtual: true });
jest.mock("@admin/components/ui/separator", () => host(), { virtual: true });
jest.mock("@admin/components/ui/radio-group", () => host(), { virtual: true });
jest.mock("@admin/components/console/status", () => host(), { virtual: true });
jest.mock("@admin/components/console/entity-icon", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/disclosure", () => host(), {
  virtual: true,
});
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
const buttons = (root: ReactTestInstance, label: string) =>
  root.findAll((node) => node.type === "button" && text(node) === label);
const links = (root: ReactTestInstance) =>
  root
    .findAll((node) => node.type === "a")
    .map((node) => [text(node), node.props.href as string]);
const checkbox = (root: ReactTestInstance) =>
  root.find((node) => node.props["data-host"] === "Checkbox");
const flush = () => act(async () => {});

const ready = ProcessProposalResultSchema.parse({
  type: "process.proposal",
  version: 1,
  sessionId: "session-1",
  revision: 3,
  reviewDigest: "c".repeat(64),
  status: "ready",
  name: "Shrnutí dne",
  description: "Dnešní schůzky a termíny v jedné větě",
  kind: "workflow",
  steps: [
    {
      type: "action",
      service: "Microsoft 365",
      action: "Dnešní schůzky",
      effect: "read",
      approval: false,
    },
    {
      type: "agent",
      task: "Shrň den do jedné věty.",
      model: "Rychlý",
      tools: [],
    },
    { type: "return", fields: ["summary"] },
  ],
  inputs: [],
  outputs: ["summary"],
  services: [{ name: "Microsoft 365", reads: true, writes: false }],
  assumptions: [
    { id: "zone", text: "Den podle Prahy", digest: "d".repeat(64) },
  ],
  questions: [],
  hubEligible: true,
  addToHub: true,
});
const status = (
  patch: Partial<ProcessProposalStatus> = {},
): ProcessProposalStatus => ({
  profile: PROCESS_PROPOSAL_PROFILE,
  sessionId: "session-1",
  state: "open",
  ...patch,
});
function fakeSession(reads: ProcessProposalStatus[], accepted?: unknown) {
  const accept = jest.fn(
    async (_request: unknown, _language: string): Promise<unknown> =>
      accepted ?? status({ state: "running" }),
  );
  let index = 0;
  const read = jest.fn(async () => reads[Math.min(index++, reads.length - 1)]!);
  return {
    session: {
      readProcessProposal: read,
      acceptProcessProposal: accept,
    } as unknown as ClientSession,
    read,
    accept,
  };
}
async function render(proposal: ProcessProposalResult, session: ClientSession) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ProcessProposalView
        session={session}
        proposal={proposal}
        disabled={false}
      />,
    );
  });
  await flush();
  return renderer;
}

test("a ready draft shows its steps and saves, tests and turns on with the overview ticked", async () => {
  const fake = fakeSession([
    status(),
    status({ state: "done", processId: "p-1", version: 1, hub: "added" }),
  ]);
  const renderer = await render(ready, fake.session);
  const root = renderer.root;
  const shown = text(root);
  for (const part of [
    "Shrnutí dne",
    "Nový proces",
    "Osobní",
    "Microsoft 365 · Dnešní schůzky",
    "AI: Shrň den do jedné věty.",
    "Výsledek: summary",
    "Bez vstupů",
    "Microsoft 365 · čte",
    "Den podle Prahy",
    "Přidat na přehled",
  ])
    expect(shown).toContain(part);
  // Numbered steps, in order.
  expect(
    root.findAll((node) => node.type === "li").map((li) => text(li)),
  ).toEqual([
    "1.Microsoft 365 · Dnešní schůzky",
    "2.AI: Shrň den do jedné věty.",
    "3.Výsledek: summary",
    "Den podle Prahy",
  ]);
  expect(checkbox(root).props.checked).toBe(true);
  expect(links(root)).toEqual([
    ["Upravit", "/processes/design?sessionId=session-1"],
  ]);
  // Nothing is saved before the press.
  expect(fake.accept).not.toHaveBeenCalled();
  await act(async () => {
    buttons(root, "Uložit a zapnout")[0]!.props.onClick();
  });
  await flush();
  expect(fake.accept).toHaveBeenCalledWith(
    {
      sessionId: "session-1",
      requestId: expect.any(String),
      revision: 3,
      reviewDigest: "c".repeat(64),
      assumptions: [{ id: "zone", digest: "d".repeat(64) }],
      addToHub: true,
    },
    "cs",
  );
  await flush();
  const done = text(root);
  expect(done).toContain("Zapnuto · na přehledu");
  expect(buttons(root, "Uložit a zapnout")).toHaveLength(0);
  expect(links(root)).toEqual([["Otevřít v Procesech", "/processes/p-1"]]);
});

test("the person can leave the overview out; a running save shows its step", async () => {
  const fake = fakeSession(
    [status()],
    status({ state: "running", phase: "testing" }),
  );
  const renderer = await render(ready, fake.session);
  // From now on the status read keeps reporting the running test.
  fake.read.mockImplementation(async () =>
    status({ state: "running", phase: "testing" }),
  );
  try {
    const root = renderer.root;
    await act(async () => {
      checkbox(root).props.onCheckedChange(false);
    });
    await act(async () => {
      buttons(root, "Uložit a zapnout")[0]!.props.onClick();
    });
    await flush();
    expect(fake.accept.mock.calls[0]![0]).toMatchObject({ addToHub: false });
    expect(text(root)).toContain("Testuji…");
    expect(buttons(root, "Uložit a zapnout")).toHaveLength(0);
  } finally {
    // Stops following the running save.
    act(() => renderer.unmount());
  }
});

test("a draft needing input cannot go on the overview and says why", async () => {
  const fake = fakeSession([status()]);
  const renderer = await render(
    {
      ...ready,
      inputs: [{ key: "day", type: "string", required: true }],
      hubEligible: false,
      addToHub: false,
    },
    fake.session,
  );
  const root = renderer.root;
  expect(text(root)).toContain("day (povinné)");
  expect(checkbox(root).props.checked).toBe(false);
  expect(checkbox(root).props.disabled).toBe(true);
  expect(text(root)).toContain("Na přehled ne: potřebuje vstup.");
  await act(async () => {
    buttons(root, "Uložit a zapnout")[0]!.props.onClick();
  });
  expect(fake.accept.mock.calls[0]![0]).toMatchObject({ addToHub: false });
});

test("a failed test says so briefly and links to the process; pressing again retries", async () => {
  const fake = fakeSession([
    status({
      state: "failed",
      processId: "p-2",
      version: 1,
      failure: "process_proposal_test_failed",
    }),
  ]);
  const renderer = await render(ready, fake.session);
  const root = renderer.root;
  expect(text(root)).toContain("Test neprošel.");
  expect(links(root)).toEqual([["Otevřít v Procesech", "/processes/p-2"]]);
  expect(buttons(root, "Uložit a zapnout")).toHaveLength(1);
});

test("a save the test could not prepare stops with a link; a refused press shows its reason", async () => {
  const stopped = fakeSession([
    status({
      state: "stopped",
      processId: "p-3",
      version: 1,
      gap: "scenario_unsupported",
    }),
  ]);
  let renderer = await render(ready, stopped.session);
  expect(text(renderer.root)).toContain(
    "Uloženo. AI krok sám zapisuje, test mu napiš v Procesech.",
  );
  expect(links(renderer.root)).toEqual([
    ["Otevřít v Procesech", "/processes/p-3"],
  ]);
  expect(buttons(renderer.root, "Uložit a zapnout")).toHaveLength(0);

  const refused = fakeSession([status()]);
  refused.accept.mockRejectedValue(
    new Error("process_proposal_budget_not_ready"),
  );
  renderer = await render(ready, refused.session);
  await act(async () => {
    buttons(renderer.root, "Uložit a zapnout")[0]!.props.onClick();
  });
  await flush();
  expect(text(renderer.root)).toContain("AI rozpočet není nastavený.");
});

test("questions and a missing budget have no save button", async () => {
  const questions = fakeSession([status()]);
  let renderer = await render(
    {
      ...ready,
      status: "questions",
      steps: [],
      questions: ["Z jakého kalendáře?"],
      hubEligible: false,
      addToHub: false,
    },
    questions.session,
  );
  expect(text(renderer.root)).toContain("Z jakého kalendáře?");
  expect(text(renderer.root)).toContain(
    "Odpověz v chatu, nebo pokračuj v Procesech.",
  );
  expect(buttons(renderer.root, "Uložit a zapnout")).toHaveLength(0);
  expect(links(renderer.root)).toEqual([
    ["Upravit", "/processes/design?sessionId=session-1"],
  ]);

  const budget = fakeSession([status()]);
  renderer = await render(
    ProcessProposalResultSchema.parse({
      ...ready,
      sessionId: null,
      revision: null,
      reviewDigest: null,
      status: "budget",
      steps: [],
      services: [],
      assumptions: [],
      hubEligible: false,
      addToHub: false,
    }),
    budget.session,
  );
  expect(text(renderer.root)).toContain(
    "AI rozpočet ještě není nastavený — požádej správce.",
  );
  expect(renderer.root.findAll((node) => node.type === "button")).toEqual([]);
  expect(budget.read).not.toHaveBeenCalled();
});

test("a model reservation no process can hold names the numbers and where to fix it; the card can be pressed again", async () => {
  const reservation = status({
    state: "stopped",
    processId: "p-4",
    version: 1,
    gap: "model_reservation_too_large",
    reservation: {
      tokens: 260096,
      costMicros: 124000,
      calls: 2,
      maxTokens: 100000,
      maxCostMicros: 10000000,
    },
  });
  let renderer = await render(ready, fakeSession([reservation]).session);
  const shown = text(renderer.root).replace(/\s/g, " ");
  expect(shown).toContain(
    "Volání AI potřebují aspoň 260 096 tokenů, proces smí mít nejvýš 100 000.",
  );
  expect(shown).toContain(
    "Požádej správce, ať v Limitech využití sníží max. odpověď modelu nebo zvýší limit běhu.",
  );
  expect(buttons(renderer.root, "Uložit a zapnout")).toHaveLength(1);
  expect(links(renderer.root)).toEqual([
    ["Otevřít v Procesech", "/processes/p-4"],
  ]);
  mockAdmin = true;
  try {
    renderer = await render(ready, fakeSession([reservation]).session);
    expect(links(renderer.root)).toEqual([
      ["Limity využití", "/admin/usage"],
      ["Otevřít v Procesech", "/processes/p-4"],
    ]);
  } finally {
    mockAdmin = false;
  }
});

test("a process turned on before its limits were sized can be saved again", async () => {
  const fake = fakeSession([
    status({
      state: "done",
      processId: "p-5",
      version: 2,
      hub: "added",
      resize: true,
    }),
  ]);
  const renderer = await render(ready, fake.session);
  expect(text(renderer.root)).toContain(
    "Limity jsou na skutečný běh malé. Ulož ho znovu.",
  );
  expect(buttons(renderer.root, "Uložit a zapnout")).toHaveLength(1);
  expect(links(renderer.root)).toEqual([
    ["Otevřít v Procesech", "/processes/p-5"],
  ]);
});
