import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { ProcessVisualEditor } from "../apps/server-admin/web/process-visual-editor";
import { editorEn } from "../apps/server-admin/web/process-editor-copy";
import type { ProcessDesignClient } from "../apps/server-admin/web/lib/process-design-client";
import type {
  DesignCapabilities,
  OwnedDesignReview,
} from "../packages/protocol/process-design";
import { DesignBriefSchema } from "../packages/protocol/process-design";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";
import { designUiCapabilities, designUiReview } from "./admin-design-fixtures";

// Exercise the editor's actual hooks and event handlers using DOM hosts. The
// design-system widgets' browser behavior is covered separately by browser QA.
jest.mock(
  "@admin/components/ui/button",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return {
      Button: (props: React.ComponentProps<"button">) =>
        React.createElement("button", props),
    };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/tooltip",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const host = ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children);
    return {
      Tooltip: host,
      TooltipTrigger: host,
      TooltipProvider: host,
      TooltipContent: () => null,
    };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/input",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return {
      Input: (props: React.ComponentProps<"input">) =>
        React.createElement("input", props),
    };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/textarea",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return {
      Textarea: (props: React.ComponentProps<"textarea">) =>
        React.createElement("textarea", props),
    };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/card",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const host = ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children);
    return { Card: host, CardHeader: host, CardTitle: host, CardContent: host };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/alert",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const host = ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children);
    return { Alert: host, AlertDescription: host };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/console/status",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return {
      StatusBadge: ({ children }: { children: React.ReactNode }) =>
        React.createElement("span", null, children),
    };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/field",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return {
      Field: ({ children }: { children: React.ReactNode }) =>
        React.createElement("div", { "data-field": true }, children),
      FieldGroup: ({ children }: { children: React.ReactNode }) =>
        React.createElement("div", null, children),
      FieldLabel: (props: React.ComponentProps<"label">) =>
        React.createElement("label", props),
      FieldSet: (props: React.ComponentProps<"fieldset">) =>
        React.createElement("fieldset", props),
      FieldLegend: (props: React.ComponentProps<"legend">) =>
        React.createElement("legend", props),
      FieldDescription: ({ children }: { children: React.ReactNode }) =>
        React.createElement("p", null, children),
    };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/select",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const host = ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children);
    return {
      Select: ({
        value,
        disabled,
        onValueChange,
        children,
      }: {
        value: string;
        disabled: boolean;
        onValueChange(value: string): void;
        children: React.ReactNode;
      }) =>
        React.createElement(
          "select",
          {
            value,
            disabled,
            onChange: (event: { target: { value: string } }) =>
              onValueChange(event.target.value),
          },
          children,
        ),
      SelectTrigger: host,
      SelectValue: host,
      SelectContent: host,
      SelectGroup: host,
      SelectItem: ({
        value,
        disabled,
        children,
      }: {
        value: string;
        disabled?: boolean;
        children: React.ReactNode;
      }) => React.createElement("option", { value, disabled }, children),
    };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/switch",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return {
      Switch: ({
        checked,
        disabled,
        onCheckedChange,
      }: {
        checked: boolean;
        disabled: boolean;
        onCheckedChange(value: boolean): void;
      }) =>
        React.createElement("input", {
          type: "checkbox",
          checked,
          disabled,
          onChange: (event: { target: { checked: boolean } }) =>
            onCheckedChange(event.target.checked),
        }),
    };
  },
  { virtual: true },
);
jest.mock("../apps/server-admin/web/hooks/use-mobile", () => ({
  useIsMobile: () => false,
  useIsWide: () => false,
}));
jest.mock(
  "@admin/components/ui/empty",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const host = ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children);
    return {
      Empty: host,
      EmptyMedia: host,
      EmptyHeader: host,
      EmptyTitle: host,
      EmptyDescription: host,
    };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/sheet",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const host = ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children);
    return {
      Sheet: ({
        open,
        modal,
        onOpenChange,
        children,
      }: {
        open: boolean;
        modal?: boolean;
        onOpenChange(open: boolean): void;
        children: React.ReactNode;
      }) =>
        open
          ? React.createElement(
              "section",
              { "data-sheet": true, "data-modal": modal },
              children,
              React.createElement(
                "button",
                {
                  "aria-label": "Close panel",
                  onClick: () => onOpenChange(false),
                },
                "Close panel",
              ),
            )
          : null,
      SheetContent: host,
      SheetHeader: host,
      SheetDescription: host,
      SheetFooter: host,
      SheetTitle: ({ children }: { children: React.ReactNode }) =>
        React.createElement("h2", null, children),
    };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/tabs",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const Context = React.createContext({
      value: "",
      onValueChange: (_value: string) => {},
    });
    return {
      Tabs: ({
        value,
        onValueChange,
        children,
      }: {
        value: string;
        onValueChange(value: string): void;
        children: React.ReactNode;
      }) =>
        React.createElement(
          Context.Provider,
          { value: { value, onValueChange } },
          children,
        ),
      TabsList: ({ children }: { children: React.ReactNode }) =>
        React.createElement("div", { role: "tablist" }, children),
      TabsTrigger: ({
        value,
        children,
      }: {
        value: string;
        children: React.ReactNode;
      }) => {
        const context = React.useContext(Context);
        return React.createElement(
          "button",
          {
            role: "tab",
            "aria-selected": context.value === value,
            onClick: () => context.onValueChange(value),
          },
          children,
        );
      },
      TabsContent: ({
        value,
        children,
      }: {
        value: string;
        children: React.ReactNode;
      }) =>
        React.useContext(Context).value === value
          ? React.createElement("div", { role: "tabpanel" }, children)
          : null,
    };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/console/disclosure",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return {
      Disclosure: ({
        title,
        children,
      }: {
        title: string;
        children: React.ReactNode;
      }) =>
        React.createElement(
          "details",
          null,
          React.createElement("summary", null, title),
          children,
        ),
    };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/console/forms",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return {
      SaveBar: ({ children }: { children: React.ReactNode }) =>
        React.createElement("footer", null, children),
      ConfirmAction: ({
        trigger,
        title,
        confirmLabel,
        cancelLabel,
        onConfirm,
      }: {
        trigger: React.ReactElement<{ onClick?: () => void }>;
        title: string;
        confirmLabel: string;
        cancelLabel: string;
        onConfirm(): void;
      }) => {
        const [open, setOpen] = React.useState(false);
        return React.createElement(
          React.Fragment,
          null,
          React.cloneElement(trigger, { onClick: () => setOpen(true) }),
          open &&
            React.createElement(
              "div",
              { role: "alertdialog" },
              title,
              React.createElement(
                "button",
                {
                  "aria-label": `Confirm ${confirmLabel}`,
                  onClick: () => {
                    setOpen(false);
                    onConfirm();
                  },
                },
                confirmLabel,
              ),
              React.createElement(
                "button",
                { onClick: () => setOpen(false) },
                cancelLabel,
              ),
            ),
        );
      },
    };
  },
  { virtual: true },
);

const mounted: TestRenderer.ReactTestRenderer[] = [];
afterEach(() => act(() => mounted.splice(0).forEach((tree) => tree.unmount())));
function text(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : text(child)))
    .join("");
}
function fixture(
  review: OwnedDesignReview = structuredClone(designUiReview),
  capabilities: DesignCapabilities = designUiCapabilities,
) {
  let current = review;
  const onDirty = jest.fn<void, [boolean]>();
  const updateCandidate = jest.fn(async (base, candidate, brief) => {
    current = {
      ...base,
      candidate: ProcessDefinitionSchema.parse(candidate),
      brief: DesignBriefSchema.parse(brief),
      revision: base.revision + 1,
      reviewDigest: "d".repeat(64),
    };
    tree.update(element());
  });
  const client = {
    updateCandidate,
    getSnapshot: () => ({ pending: null, review: current }),
  } as unknown as ProcessDesignClient;
  let tree: TestRenderer.ReactTestRenderer;
  const element = () => (
    <ProcessVisualEditor
      client={client}
      review={current}
      capabilities={capabilities}
      language="en"
      blocked={false}
      onDirty={onDirty}
    />
  );
  act(() => {
    tree = TestRenderer.create(element());
  });
  mounted.push(tree!);
  const buttons = (label: string) =>
    tree.root
      .findAllByType("button")
      .filter(
        (item) => text(item) === label || item.props["aria-label"] === label,
      );
  // The step picker lists flow steps, then services; a service opens its actions.
  const pickAction = () => {
    const options = () =>
      tree.root.findAll(
        (node) =>
          node.type === "button" &&
          node.props.role === "option" &&
          !node.props.disabled,
      );
    const flow: string[] = [editorEn.agent, editorEn.branch, editorEn.return];
    const service = options().find(
      (node) => !flow.includes(node.props["aria-label"]),
    );
    if (!service) throw new Error("Missing service option");
    act(() => service.props.onClick());
    act(() => options()[0]!.props.onClick());
  };
  const button = (label: string) => {
    const result = buttons(label)[0];
    if (!result) throw new Error(`Missing button ${label}`);
    return result;
  };
  const field = (label: string) => {
    const result = tree.root.findAll(
      (node) =>
        node.type === "div" &&
        node.props["data-field"] === true &&
        node.findAllByType("label").some((item) => text(item) === label),
    )[0];
    if (!result) throw new Error(`Missing field ${label}`);
    return result;
  };
  const click = (label: string) => act(() => button(label).props.onClick());
  const closePanels = () =>
    act(() =>
      tree.root
        .findAllByType("button")
        .filter((item) => item.props["aria-label"] === "Close panel")
        .forEach((item) => item.props.onClick()),
    );
  const tab = (value: "parameters" | "settings") => click(editorEn[value]);
  const selectStep = (id: string) =>
    act(() =>
      tree.root
        .findAllByType("button")
        .find(
          (item) => item.props["aria-label"] === `${editorEn.select}: ${id}`,
        )!
        .props.onClick(),
    );
  const openNode = (
    id: string,
    value: "parameters" | "settings" = "parameters",
  ) => {
    closePanels();
    selectStep(id);
    tab(value);
  };
  const openRoot = () => {
    closePanels();
    act(() =>
      tree.root
        .findAllByType("button")
        .find((item) => item.props["aria-label"] === editorEn.processSettings)!
        .props.onClick(),
    );
  };
  const change = (label: string, value: string) =>
    act(() =>
      field(label)
        .findAll(
          (node) => node.type === "input" || node.type === "textarea",
        )[0]!
        .props.onChange({ target: { value } }),
    );
  const choose = (label: string, value: string) =>
    act(() =>
      field(label).findByType("select").props.onChange({ target: { value } }),
    );
  const apply = (label: string) =>
    act(() => field(label).findByType("button").props.onClick());
  const confirm = (label: string) => {
    click(label);
    act(() =>
      tree.root
        .findByProps({ "aria-label": `Confirm ${label}` })
        .props.onClick(),
    );
  };
  return {
    tree: tree!,
    field,
    buttons,
    button,
    click,
    pickAction,
    closePanels,
    openRoot,
    openNode,
    selectStep,
    tab,
    change,
    choose,
    apply,
    confirm,
    onDirty,
    updateCandidate,
    dirty: () => onDirty.mock.calls.at(-1)?.[0],
    refresh: (next: OwnedDesignReview) =>
      act(() => {
        current = next;
        tree.update(element());
      }),
    save: async () => {
      closePanels();
      await act(async () => {
        button(editorEn.save).props.onClick();
        await Promise.resolve();
      });
    },
  };
}

test("step and process schemas retain independent drafts across sheet closes before saving both changes", async () => {
  const f = fixture();
  f.openNode("lookup", "settings");
  const stepSchema = JSON.parse(
    f.field(editorEn.outputSchema).findByType("textarea").props.value,
  );
  stepSchema.properties.stepOnly = { type: "boolean" };
  const stepDraft = JSON.stringify(stepSchema);
  f.change(editorEn.outputSchema, stepDraft);
  f.openRoot();
  const rootSchema = JSON.parse(
    f.field(editorEn.outputSchema).findByType("textarea").props.value,
  );
  rootSchema.properties.rootOnly = { type: "string" };
  f.change(editorEn.outputSchema, JSON.stringify(rootSchema));
  expect(f.dirty()).toBe(true);
  expect(f.button(editorEn.save).props.disabled).toBe(true);
  f.apply(editorEn.outputSchema);
  expect(f.button(editorEn.save).props.disabled).toBe(true);
  f.openNode("lookup", "settings");
  expect(
    f.field(editorEn.outputSchema).findByType("textarea").props.value,
  ).toBe(stepDraft);
  f.apply(editorEn.outputSchema);
  expect(f.button(editorEn.save).props.disabled).toBe(false);
  await f.save();
  const candidate = f.updateCandidate.mock.calls[0]![1];
  expect(
    candidate.steps.find((step: { id: string }) => step.id === "lookup")
      .outputSchema.properties.stepOnly,
  ).toEqual({ type: "boolean" });
  expect(candidate.outputSchema.properties.rootOnly).toEqual({
    type: "string",
  });
  expect(f.dirty()).toBe(false);
});

test.each([
  ["lookup", editorEn.input, "null"],
  ["check", editorEn.condition, "null"],
  ["check", editorEn.condition, '{"operator":"exists","left":null}'],
  ["finish", editorEn.output, "null"],
  ["finish", editorEn.output, '{"found":null}'],
  ["finish", editorEn.output, "{"],
])(
  "invalid advanced JSON for %s/%s stays editable without crashing or dispatching",
  (step, label, invalid) => {
    const f = fixture();
    f.openNode(step, "settings");
    f.change(label, invalid);
    f.apply(label);
    expect(f.field(label).findByType("textarea").props.value).toBe(invalid);
    expect(f.field(label).findByType("textarea").props["aria-invalid"]).toBe(
      true,
    );
    expect(f.field(label).findByProps({ role: "alert" }).children).toContain(
      editorEn.invalid,
    );
    expect(f.dirty()).toBe(true);
    expect(f.button(editorEn.save).props.disabled).toBe(true);
    f.openNode(step, "parameters");
    f.tab("settings");
    expect(f.field(label).findByType("textarea").props.value).toBe(invalid);
    expect(f.updateCandidate).not.toHaveBeenCalled();
  },
);

test("save adopts the normalized purpose and new review, clearing dirty and stale state", async () => {
  const f = fixture();
  f.openRoot();
  f.change(editorEn.purpose, `  ${designUiReview.brief.purpose}\n`);
  expect(f.button(editorEn.save).props.disabled).toBe(false);
  await f.save();
  expect(f.updateCandidate.mock.calls[0]![2].purpose).toBe(
    designUiReview.brief.purpose,
  );
  f.openRoot();
  expect(f.field(editorEn.purpose).findByType("textarea").props.value).toBe(
    designUiReview.brief.purpose,
  );
  expect(f.dirty()).toBe(false);
  expect(JSON.stringify(f.tree.toJSON())).not.toContain(editorEn.stale);
  expect(f.button(editorEn.save).props.disabled).toBe(true);
});

test("an incomplete name does not throw when rewiring and restoring the name retains the changed edge", async () => {
  const f = fixture();
  f.openRoot();
  f.change(editorEn.name, "");
  f.openNode("lookup");
  expect(() => f.choose(editorEn.next, "finish")).not.toThrow();
  expect(f.field(editorEn.next).findByType("select").props.value).toBe(
    "finish",
  );
  expect(f.button(editorEn.save).props.disabled).toBe(true);
  f.openNode("explain");
  f.choose(editorEn.next, "lookup");
  f.openRoot();
  f.choose(editorEn.entry, "check");
  f.change(editorEn.name, "TEST restored name");
  expect(f.button(editorEn.save).props.disabled).toBe(false);
  await f.save();
  expect(
    f.updateCandidate.mock.calls[0]![1].steps.find(
      (step: { id: string }) => step.id === "lookup",
    ).next,
  ).toBe("finish");
});

test("graph rename rewrites bindings, referenced removal is refused, and confirmed isolated deletion preserves wiring", async () => {
  const f = fixture();
  f.openNode("lookup", "settings");
  f.change(editorEn.stepId, "search");
  f.click(editorEn.rename);
  f.openNode("check", "settings");
  expect(
    JSON.parse(f.field(editorEn.condition).findByType("textarea").props.value)
      .left.stepId,
  ).toBe("search");
  f.openNode("finish", "settings");
  expect(
    JSON.parse(f.field(editorEn.output).findByType("textarea").props.value)
      .found.stepId,
  ).toBe("search");
  f.openNode("search", "settings");
  f.confirm(editorEn.remove);
  expect(JSON.stringify(f.tree.toJSON())).toContain(editorEn.referenced);
  f.closePanels();
  f.click(editorEn.add);
  f.click(editorEn.return);
  expect(JSON.stringify(f.tree.toJSON())).toContain(editorEn.unreachable);
  f.confirm(editorEn.remove);
  expect(
    f.tree.root
      .findAllByType("button")
      .some(
        (button) =>
          button.props["aria-label"] === `${editorEn.select}: return_1`,
      ),
  ).toBe(false);
  expect(f.button(editorEn.save).props.disabled).toBe(false);
  await f.save();
  const candidate = f.updateCandidate.mock.calls[0]![1];
  expect(candidate.entry).toBe("search");
  expect(candidate.steps).toHaveLength(4);
  expect(
    candidate.steps.find((step: { id: string }) => step.id === "search").next,
  ).toBe("check");
});

test("human input settings persist the explicit agent capability", async () => {
  const f = fixture();
  f.openNode("explain", "settings");
  act(() =>
    f
      .field(editorEn.optionalHuman)
      .findByType("input")
      .props.onChange({ target: { checked: true } }),
  );
  await f.save();
  expect(
    f.updateCandidate.mock.calls[0]![1].steps.find(
      (step: { id: string }) => step.id === "explain",
    ).humanInput,
  ).toBe("text");
});

test("a fresh server review reconciles automatically when the editor has no local edits", () => {
  const f = fixture();
  const latest = structuredClone(designUiReview);
  latest.revision++;
  latest.reviewDigest = "e".repeat(64);
  latest.candidate!.name = "TEST latest proposal";
  latest.brief.purpose = "TEST latest purpose";
  f.refresh(latest);
  f.openRoot();
  expect(f.field(editorEn.name).findByType("input").props.value).toBe(
    "TEST latest proposal",
  );
  expect(f.field(editorEn.purpose).findByType("textarea").props.value).toBe(
    "TEST latest purpose",
  );
  expect(f.dirty()).toBe(false);
  expect(JSON.stringify(f.tree.toJSON())).not.toContain(editorEn.stale);
  expect(f.button(editorEn.save).props.disabled).toBe(true);
});

test("review refresh retains applied and unapplied edits and blocks stale save until confirmed discard", () => {
  const f = fixture();
  f.openRoot();
  f.change(editorEn.name, "TEST local name");
  f.openNode("lookup", "settings");
  const draft = "{ incomplete local bindings";
  f.change(editorEn.input, draft);
  f.closePanels();
  const latest = structuredClone(designUiReview);
  latest.revision++;
  latest.reviewDigest = "e".repeat(64);
  latest.candidate!.name = "TEST remote name";
  f.refresh(latest);
  f.openRoot();
  expect(f.field(editorEn.name).findByType("input").props.value).toBe(
    "TEST local name",
  );
  f.openNode("lookup", "settings");
  expect(f.field(editorEn.input).findByType("textarea").props.value).toBe(
    draft,
  );
  expect(JSON.stringify(f.tree.toJSON())).toContain(editorEn.stale);
  f.change(
    editorEn.input,
    JSON.stringify({ name: { source: "input", path: ["name"] } }),
  );
  f.apply(editorEn.input);
  expect(f.button(editorEn.save).props.disabled).toBe(true);
  expect(f.updateCandidate).not.toHaveBeenCalled();
  f.closePanels();
  f.confirm(editorEn.reset);
  f.openRoot();
  expect(f.field(editorEn.name).findByType("input").props.value).toBe(
    "TEST remote name",
  );
  expect(f.dirty()).toBe(false);
  expect(JSON.stringify(f.tree.toJSON())).not.toContain(editorEn.stale);
});

test("unavailable service, action and model references survive unrelated edits", async () => {
  const f = fixture(structuredClone(designUiReview), {
    ...designUiCapabilities,
    services: [],
    models: [],
  });
  f.openNode("lookup");
  for (const [label, value] of [
    [editorEn.serviceId, "test_service"],
    [editorEn.actionId, "test_action"],
  ]) {
    expect(f.field(label!).findByType("select").props.value).toBe(value);
    expect(f.field(label!).findByType("option").props).toMatchObject({
      value,
      disabled: true,
    });
  }
  f.openNode("explain");
  expect(f.field(editorEn.modelId).findByType("select").props.value).toBe(
    "test_model",
  );
  expect(f.field(editorEn.modelId).findByType("option").props.disabled).toBe(
    true,
  );
  f.openRoot();
  f.change(editorEn.name, "TEST references retained");
  await f.save();
  expect(f.updateCandidate.mock.calls[0]![1].steps).toEqual(
    designUiReview.candidate!.kind === "workflow"
      ? designUiReview.candidate!.steps
      : [],
  );
});

test("an incomplete numeric comparison survives tab changes, node changes and inspector closes", async () => {
  const f = fixture();
  f.openNode("check");
  f.choose(editorEn.literalType, "number");
  f.change(editorEn.comparison, "-");
  expect(
    f.field(editorEn.comparison).findByType("input").props["aria-invalid"],
  ).toBe(true);
  expect(f.button(editorEn.save).props.disabled).toBe(true);
  f.tab("settings");
  f.tab("parameters");
  expect(f.field(editorEn.comparison).findByType("input").props.value).toBe(
    "-",
  );
  f.openNode("finish");
  f.openNode("check");
  expect(f.field(editorEn.comparison).findByType("input").props.value).toBe(
    "-",
  );
  f.choose(editorEn.literalType, "boolean");
  expect(f.button(editorEn.save).props.disabled).toBe(false);
  await f.save();
  expect(
    f.updateCandidate.mock.calls[0]![1].steps.find(
      (step: { id: string }) => step.id === "check",
    ).condition.right,
  ).toBe(false);
});

test.each(["operator selector", "advanced JSON"] as const)(
  "%s replacement with exists removes the obsolete invalid comparison draft",
  async (replacement) => {
    const f = fixture();
    f.openNode("check");
    f.choose(editorEn.literalType, "number");
    f.change(editorEn.comparison, "-");
    expect(f.button(editorEn.save).props.disabled).toBe(true);
    const condition = {
      operator: "exists",
      left: { source: "step", stepId: "lookup", path: ["found"] },
    };
    if (replacement === "operator selector") {
      f.choose(editorEn.operator, "exists");
    } else {
      f.tab("settings");
      // A failed replacement must retain the original condition and its draft.
      f.change(editorEn.condition, "null");
      f.apply(editorEn.condition);
      expect(f.button(editorEn.save).props.disabled).toBe(true);
      f.change(editorEn.condition, JSON.stringify(condition));
      f.apply(editorEn.condition);
      f.tab("parameters");
    }
    expect(f.field(editorEn.operator).findByType("select").props.value).toBe(
      "exists",
    );
    expect(() => f.field(editorEn.comparison)).toThrow("Missing field");
    expect(f.dirty()).toBe(true);
    expect(f.button(editorEn.save).props.disabled).toBe(false);
    await f.save();
    expect(
      f.updateCandidate.mock.calls[0]![1].steps.find(
        (step: { id: string }) => step.id === "check",
      ).condition,
    ).toEqual(condition);
    expect(f.dirty()).toBe(false);
  },
);

test.each([
  {
    step: "lookup",
    field: "name",
    configuration: "input" as const,
    replacement: { name: { source: "input", path: ["name"] } },
    source: "input",
  },
  {
    step: "finish",
    field: "found",
    configuration: "output" as const,
    replacement: {
      found: { source: "step", stepId: "lookup", path: ["found"] },
    },
    source: "step:lookup",
  },
  {
    step: "check",
    field: "value",
    configuration: "condition" as const,
    replacement: {
      operator: "exists",
      left: { source: "step", stepId: "lookup", path: ["found"] },
    },
    source: "step:lookup",
  },
])(
  "applying advanced $configuration clears its replaced incomplete literal draft",
  async ({ step, field, configuration, replacement, source }) => {
    const f = fixture();
    f.openRoot();
    f.change(editorEn.name, "TEST valid edit alongside binding replacement");
    f.openNode(step);
    f.choose(`${field} · ${editorEn.bindingSource}`, "literal");
    f.choose(`${field} · ${editorEn.literalType}`, "number");
    f.change(`${field} · ${editorEn.value}`, "-");
    expect(f.button(editorEn.save).props.disabled).toBe(true);
    f.tab("settings");
    f.change(editorEn[configuration], JSON.stringify(replacement));
    f.apply(editorEn[configuration]);
    f.tab("parameters");
    expect(
      f.field(`${field} · ${editorEn.bindingSource}`).findByType("select").props
        .value,
    ).toBe(source);
    expect(() => f.field(`${field} · ${editorEn.value}`)).toThrow(
      "Missing field",
    );
    expect(f.button(editorEn.save).props.disabled).toBe(false);
    await f.save();
    expect(
      f.updateCandidate.mock.calls[0]![1].steps.find(
        (node: { id: string }) => node.id === step,
      )[configuration],
    ).toEqual(replacement);
    expect(f.dirty()).toBe(false);
  },
);

test("an empty proposal opens first-step choices and can create a result without a model or duplicate terminal", async () => {
  const f = fixture(
    { ...structuredClone(designUiReview), candidate: null },
    { ...designUiCapabilities, models: [] },
  );
  f.click(editorEn.create);
  expect(f.dirty()).toBe(false);
  expect(f.button(editorEn.agent).props.disabled).toBe(true);
  f.click(editorEn.return);
  expect(f.dirty()).toBe(true);
  await f.save();
  const definition = f.updateCandidate.mock.calls[0]![1];
  expect(definition.kind).toBe("workflow");
  expect(definition.steps).toHaveLength(1);
  expect(definition.steps[0].type).toBe("return");
  expect(definition.entry).toBe(definition.steps[0].id);
});

test("choosing the first service action creates a connected workflow locally", async () => {
  const f = fixture({ ...structuredClone(designUiReview), candidate: null });
  f.click(editorEn.create);
  f.pickAction();
  expect(f.updateCandidate).not.toHaveBeenCalled();
  await f.save();
  const definition = f.updateCandidate.mock.calls[0]![1];
  expect(definition.kind).toBe("workflow");
  expect(definition.steps).toHaveLength(2);
  const first = definition.steps.find(
    (step: { id: string }) => step.id === definition.entry,
  );
  expect(first.type).toBe("action");
  expect(
    definition.steps.find((step: { id: string }) => step.id === first.next)
      .type,
  ).toBe("return");
});
