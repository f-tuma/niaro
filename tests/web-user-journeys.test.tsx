import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import {
  ProcessEditsGuard,
  useProcessEditsGuard,
} from "../apps/server-admin/web/process-edits-guard";
import { processReviewOrder } from "../apps/server-admin/web/lib/process-review-order";
import {
  addStep,
  createWorkflow,
} from "../apps/server-admin/web/lib/process-editor";
import { SuiteEditor } from "../apps/server-admin/web/process-test-suite";
import { newCaseDraft } from "../apps/server-admin/web/lib/process-test-suite";
import { testEn } from "../apps/server-admin/web/process-test-copy";
import { ConsoleShell } from "../apps/server-admin/web/console-shell";
import {
  DesignWorkspace,
  designSearchSchema,
} from "../apps/server-admin/web/process-design-page";
import { designEn } from "../apps/server-admin/web/process-design-copy";
import { ProcessVisualEditor } from "../apps/server-admin/web/process-visual-editor";
import { editorEn } from "../apps/server-admin/web/process-editor-copy";
import type { ProcessDesignClient } from "../apps/server-admin/web/lib/process-design-client";
import type {
  DesignCapabilities,
  OwnedDesignReview,
} from "../packages/protocol/process-design";
import { DesignBriefSchema } from "../packages/protocol/process-design";
import {
  processValueSchema,
  ProcessDefinitionSchema,
} from "../packages/protocol/service-processes";
import { designUiCapabilities, designUiReview } from "./admin-design-fixtures";
import { ProcessHostContext } from "../apps/server-admin/web/process-host";

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
    return {
      Card: host,
      CardHeader: host,
      CardTitle: host,
      CardContent: host,
      CardAction: host,
    };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/alert",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const host = ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children);
    return {
      Alert: host,
      AlertDescription: host,
      AlertTitle: host,
      AlertAction: host,
    };
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
      StatusDot: ({ children }: { children: React.ReactNode }) =>
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
      EmptyContent: host,
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
      MoreActions: ({ children }: { children: React.ReactNode }) =>
        React.createElement("div", null, children),
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

let mockBlockerOptions: {
  shouldBlockFn: (locations?: unknown) => boolean;
  enableBeforeUnload: boolean;
  withResolver: boolean;
};
const mockNavigate = jest.fn();
let mockLeave = {
  status: "idle",
  reset: jest.fn(),
  proceed: jest.fn(),
};
jest.mock("@tanstack/react-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    Link: (props: React.ComponentProps<"a">) => React.createElement("a", props),
    useNavigate: () => mockNavigate,
    useRouterState: () => "/processes/design",
    useBlocker: (options: typeof mockBlockerOptions) => {
      mockBlockerOptions = options;
      return mockLeave;
    },
  };
});
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
jest.mock("../apps/server-admin/web/catalog-shared", () => ({}));
jest.mock("../apps/server-admin/web/service-process-overview", () => ({}));
jest.mock("../apps/server-admin/web/process-design-review", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const host = ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children);
  return { ProcessDesignReview: host, Disclosure: host, JsonDetail: host };
});
jest.mock("@admin/components/ui/skeleton", () => ({ Skeleton: () => null }), {
  virtual: true,
});
jest.mock("@admin/components/ui/markdown", () => ({ Markdown: () => null }), {
  virtual: true,
});
jest.mock(
  "@admin/components/console/page",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return {
      PageHeader: ({ actions }: { actions: React.ReactNode }) =>
        React.createElement("header", null, actions),
      PageTitleProvider: ({
        children,
      }: {
        children: (title: string) => React.ReactNode;
      }) => children("Process designer"),
    };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/alert-dialog",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const host = ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children);
    return {
      AlertDialog: ({
        open,
        onOpenChange,
        children,
      }: {
        open: boolean;
        onOpenChange: (open: boolean) => void;
        children: React.ReactNode;
      }) =>
        open
          ? React.createElement(
              "section",
              { role: "alertdialog", onOpenChange },
              children,
            )
          : null,
      AlertDialogContent: host,
      AlertDialogHeader: host,
      AlertDialogTitle: host,
      AlertDialogDescription: host,
      AlertDialogFooter: host,
      AlertDialogAction: (props: React.ComponentProps<"button">) =>
        React.createElement("button", props),
      AlertDialogCancel: (props: React.ComponentProps<"button">) =>
        React.createElement("button", props),
    };
  },
  { virtual: true },
);

const mockAdmin = {
  language: "en",
  selectedOrganization: "test_org",
  selectedWorkspace: "test_workspace",
  setSelectedOrganization: jest.fn(),
  setSelectedWorkspace: jest.fn(),
  setLanguage: jest.fn(),
  data: {
    server: { name: "TEST server" },
    authentication: { current: "better-auth" },
  },
};
const mockConsoleScope = {
  organization: { id: "test_org", name: "TEST organization" },
  workspace: { id: "test_workspace", name: "TEST workspace" },
  identity: {
    data: {
      user: { name: "Test user", email: "user@example.test" },
      organizations: [
        { id: "test_org", name: "TEST organization" },
        { id: "second_org", name: "Second organization" },
      ],
    },
  },
  detail: {
    data: {
      workspaces: [
        { id: "test_workspace", name: "TEST workspace" },
        { id: "second_workspace", name: "Second workspace" },
      ],
    },
  },
};
jest.mock("../apps/server-admin/web/context", () => ({
  useAdmin: () => mockAdmin,
}));
jest.mock("../apps/server-admin/web/console-scope", () => ({
  useConsoleScope: () => mockConsoleScope,
}));
jest.mock("../apps/server-admin/web/shell-copy", () => {
  const actual = jest.requireActual<
    typeof import("../apps/server-admin/web/shell-copy")
  >("../apps/server-admin/web/shell-copy");
  return {
    useShellCopy: () => ({
      ...actual.useShellCopy(),
      switchWorkspace: "Switch workspace",
      signOut: "Sign out",
    }),
  };
});
jest.mock(
  "@admin/lib/theme",
  () => ({ useTheme: () => "light", setTheme: jest.fn() }),
  { virtual: true },
);
jest.mock(
  "@admin/components/console/entity-icon",
  () => ({
    initials: (s: string) => s.slice(0, 2),
    EntityIcon: ({ children }: { children: unknown }) => children,
  }),
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/sidebar",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const host = ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children);
    return {
      ...Object.fromEntries(
        [
          "Sidebar",
          "SidebarContent",
          "SidebarFooter",
          "SidebarGroup",
          "SidebarGroupContent",
          "SidebarGroupLabel",
          "SidebarHeader",
          "SidebarInset",
          "SidebarMenu",
          "SidebarMenuButton",
          "SidebarMenuItem",
          "SidebarProvider",
          "SidebarRail",
          "SidebarTrigger",
        ].map((name) => [name, host]),
      ),
      useSidebar: () => ({ isMobile: false, setOpenMobile: jest.fn() }),
    };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/breadcrumb",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const host = ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children);
    return Object.fromEntries(
      [
        "Breadcrumb",
        "BreadcrumbItem",
        "BreadcrumbLink",
        "BreadcrumbList",
        "BreadcrumbPage",
        "BreadcrumbSeparator",
      ].map((name) => [name, host]),
    );
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/dropdown-menu",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const host = ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children);
    return {
      ...Object.fromEntries(
        [
          "DropdownMenu",
          "DropdownMenuContent",
          "DropdownMenuGroup",
          "DropdownMenuLabel",
          "DropdownMenuRadioGroup",
          "DropdownMenuRadioItem",
          "DropdownMenuSeparator",
          "DropdownMenuSub",
          "DropdownMenuSubContent",
          "DropdownMenuSubTrigger",
          "DropdownMenuTrigger",
        ].map((name) => [name, host]),
      ),
      DropdownMenuItem: ({
        children,
        onSelect,
        disabled,
      }: {
        children?: React.ReactNode;
        onSelect?: () => void;
        disabled?: boolean;
      }) =>
        React.createElement(
          "button",
          { onClick: onSelect, disabled, "data-menu-item": true },
          children,
        ),
    };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/avatar",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const host = ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children);
    return { Avatar: host, AvatarFallback: host };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/tooltip",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const host = ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children);
    return { Tooltip: host, TooltipContent: host, TooltipTrigger: host };
  },
  { virtual: true },
);
jest.mock("@admin/components/ui/separator", () => ({ Separator: () => null }), {
  virtual: true,
});

jest.mock(
  "@admin/components/ui/collapsible",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const host = ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children);
    return {
      Collapsible: host,
      CollapsibleContent: host,
      CollapsibleTrigger: host,
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

test("novice blank workflow explains its missing purpose and can save after filling it", async () => {
  const review = structuredClone(designUiReview);
  review.candidate = null;
  review.brief.purpose = "";
  const f = fixture(review);
  f.click(editorEn.create);
  f.click(editorEn.return);
  f.closePanels();
  expect(f.dirty()).toBe(true);
  expect(f.button(editorEn.save).props.disabled).toBe(true);
  expect(JSON.stringify(f.tree.toJSON())).toContain(editorEn.purposeMissing);
  f.openRoot();
  f.change(editorEn.purpose, "Return a message");
  f.closePanels();
  expect(f.button(editorEn.save).props.disabled).toBe(false);
});

test("a novice can declare an action output field and bind it downstream without JSON", async () => {
  const f = fixture({ ...structuredClone(designUiReview), candidate: null });
  f.click(editorEn.create);
  f.pickAction();
  f.choose(`name · ${editorEn.bindingSource}`, "literal");
  f.change(`name · ${editorEn.value}`, "Alice");
  const schema = () => schemaControls(f.tree, editorEn.outputSchema);
  schema().add();
  schema().rename(0, "message");
  f.openNode("finish");
  f.choose(`result · ${editorEn.bindingSource}`, "step:action_1");
  expect(
    f
      .field(`result · ${editorEn.path}`)
      .findAllByType("option")
      .map((o) => o.props.value),
  ).toEqual(["[]", '["message"]']);
  f.choose(`result · ${editorEn.path}`, '["message"]');
  await f.save();
  const definition = f.updateCandidate.mock.calls[0]![1];
  const action = definition.steps.find(
    (s: { type: string }) => s.type === "action",
  );
  expect(
    processValueSchema(action.outputSchema).safeParse({
      message: "Alice found",
    }).success,
  ).toBe(true);
  expect(
    definition.steps.find((s: { type: string }) => s.type === "return").output
      .result,
  ).toEqual({ source: "step", stepId: "action_1", path: ["message"] });
});

test("service switch selects a supported action and discards stale action contract", async () => {
  const caps = structuredClone(designUiCapabilities);
  caps.services.push({
    ...caps.services[0]!,
    id: "second_service",
    name: "Second service",
    actions: [
      {
        ...caps.services[0]!.actions[0]!,
        id: "second_action",
        name: "New lookup",
      },
    ],
  });
  const f = fixture(structuredClone(designUiReview), caps);
  f.openNode("lookup");
  f.choose(editorEn.serviceId, "second_service");
  const selection = f.field(editorEn.actionId).findByType("select");
  expect(selection.props.value).toBe("second_action");
  expect(
    selection
      .findAllByType("option")
      .some((o) => o.props.value === "test_action"),
  ).toBe(false);
  await f.save();
  const action = f.updateCandidate.mock.calls[0]![1].steps.find(
    (s: { id: string }) => s.id === "lookup",
  );
  expect(action.serviceId).toBe("second_service");
  expect(action.actionId).toBe("second_action");
  expect(action.input).toEqual({});
  expect(action.outputSchema.properties).toEqual({});
});

function workspaceFixture(
  promote = false,
  inShell = false,
  options: {
    initialView?: "conversation" | "canvas" | "review";
    holdPromotion?: boolean;
    noCandidate?: boolean;
    foreignWorkspace?: boolean;
  } = {},
) {
  mockLeave = { status: "idle", reset: jest.fn(), proceed: jest.fn() };
  mockNavigate.mockClear();
  let review: OwnedDesignReview = structuredClone(designUiReview);
  if (options.noCandidate) review.candidate = null;
  if (options.foreignWorkspace) review.workspaceId = "foreign_workspace";
  let snapshot = {
    sessionId: review.id,
    review: review as OwnedDesignReview,
    capabilities: designUiCapabilities,
    modelId: "test_model",
    turns: [],
    rejectedTurns: [],
    composer: "",
    fresh: true,
    loading: false,
    initializing: options.holdPromotion ?? false,
    handoff: false,
    dispatching: false,
    pending: null,
    error: null,
    denied: false,
  };
  const client = {
    scope: {
      organizationId: "test_org",
      workspaceId: "test_workspace",
      serviceId: "test_service",
      ...(promote ? {} : { sessionId: review.id }),
    },
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    blocked: false,
    canSend: false,
    updateCandidate: jest.fn(async (base, candidate, brief) => {
      review = {
        ...base,
        candidate,
        brief,
        revision: base.revision + 1,
        reviewDigest: "f".repeat(64),
      };
      snapshot = { ...snapshot, review };
      tree.update(element());
    }),
  } as unknown as ProcessDesignClient;
  const logout = jest.fn();
  const element = () =>
    inShell ? (
      <ConsoleShell
        logout={logout}
        refresh={() => {}}
        busy={false}
        refreshing={false}
      >
        <DesignWorkspace
          client={client}
          copy={designEn}
          language="en"
          initialView={options.initialView}
        />
      </ConsoleShell>
    ) : (
      <DesignWorkspace
        client={client}
        copy={designEn}
        language="en"
        initialView={options.initialView}
      />
    );
  let tree: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(element());
  });
  mounted.push(tree!);
  const click = (label: string) =>
    act(() =>
      tree.root
        .findAllByType("button")
        .find(
          (node) => text(node) === label || node.props["aria-label"] === label,
        )!
        .props.onClick(),
    );
  const edit = () => {
    act(() =>
      tree.root
        .findAllByType("button")
        .find((node) => node.props["aria-label"] === editorEn.processSettings)!
        .props.onClick(),
    );
    const field = tree.root.findAll(
      (node) =>
        node.type === "div" &&
        node.props["data-field"] &&
        node
          .findAllByType("label")
          .some((label) => text(label) === editorEn.name),
    )[0]!;
    act(() =>
      field
        .findByType("input")
        .props.onChange({ target: { value: "Protect these local edits" } }),
    );
  };
  return {
    tree: tree!,
    client,
    edit,
    click,
    rerender: () => act(() => tree.update(element())),
    settlePromotion: () =>
      act(() => {
        snapshot = { ...snapshot, initializing: false };
        tree.update(element());
      }),
    updateReview: (next: OwnedDesignReview) =>
      act(() => {
        review = next;
        snapshot = { ...snapshot, review };
        tree.update(element());
      }),
  };
}

test("designer guards dirty sidebar/back/new-conversation exits and reload while clean edits do not block", async () => {
  const f = workspaceFixture();
  expect(mockBlockerOptions.shouldBlockFn()).toBe(false);
  expect(mockBlockerOptions.enableBeforeUnload).toBe(false);
  f.edit();
  expect(mockBlockerOptions.withResolver).toBe(true);
  expect(mockBlockerOptions.enableBeforeUnload).toBe(true);
  for (const path of [
    "/services",
    "/processes",
    "/services/test_service/processes/design",
  ]) {
    expect(mockBlockerOptions.shouldBlockFn({ next: { pathname: path } })).toBe(
      true,
    );
  }
  expect(
    f.tree.root
      .findAllByType("a")
      .some((node) => text(node) === designEn.newConversation),
  ).toBe(true);
  await act(async () => {
    f.tree.root
      .findAllByType("button")
      .find((node) => text(node) === editorEn.save)!
      .props.onClick();
    await Promise.resolve();
  });
  expect(mockBlockerOptions.shouldBlockFn()).toBe(false);
  expect(mockBlockerOptions.enableBeforeUnload).toBe(false);
});

test("leaving asks separately from accepting a process and keep-editing/reset preserve the canvas", () => {
  const f = workspaceFixture();
  f.edit();
  mockLeave.status = "blocked";
  f.rerender();
  expect(f.tree.root.findAllByProps({ role: "alertdialog" })).toHaveLength(1);
  expect(JSON.stringify(f.tree.toJSON())).toContain(designEn.leaveTitle);
  f.click(designEn.stayAction);
  expect(mockLeave.reset).toHaveBeenCalledTimes(1);
  expect(mockLeave.proceed).not.toHaveBeenCalled();
  expect(mockBlockerOptions.shouldBlockFn()).toBe(true);
  f.click(designEn.leaveAction);
  expect(mockLeave.proceed).toHaveBeenCalledTimes(1);
  expect(f.client.updateCandidate as jest.Mock).not.toHaveBeenCalled();
});

test("automatic verified session URL promotion remains unblocked for a clean canvas", () => {
  workspaceFixture(true);
  expect(mockBlockerOptions.shouldBlockFn()).toBe(false);
  expect(mockNavigate).toHaveBeenCalledWith(
    expect.objectContaining({
      search: { sessionId: designUiReview.id, view: "canvas" },
      replace: true,
    }),
  );
});

test("new service actions skip unavailable schemas and choose a supported action", () => {
  const caps = structuredClone(designUiCapabilities);
  const unavailable = caps.services[0]!.actions[0]!;
  caps.services[0]!.actions.push({
    ...unavailable,
    id: "supported_action",
    name: "Supported lookup",
  });
  unavailable.schemaUnavailable = "schema_unsupported";
  unavailable.inputSchema = null;
  const f = fixture(
    { ...structuredClone(designUiReview), candidate: null },
    caps,
  );
  f.click(editorEn.create);
  f.pickAction();
  const selection = f.field(editorEn.actionId).findByType("select");
  expect(selection.props.value).toBe("supported_action");
  expect(
    selection
      .findAllByType("option")
      .find((o) => o.props.value === unavailable.id)!.props.disabled,
  ).toBe(true);
  expect(f.button(editorEn.save).props.disabled).toBe(false);
});

const scopeA = { organizationId: "test_org", workspaceId: "test_workspace" };
const scopeB = {
  organizationId: "second_org",
  workspaceId: "second_workspace",
};
function ScopeGuardHarness({
  dirty,
  scope,
  changeWorkspace,
  changeOrganization,
  signOut,
}: {
  dirty: boolean;
  scope: typeof scopeA;
  changeWorkspace: () => void;
  changeOrganization: () => void;
  signOut: () => void;
}) {
  const guard = useProcessEditsGuard();
  React.useEffect(() => guard.register(scope, dirty), [guard, dirty, scope]);
  return (
    <>
      <button onClick={() => guard.request(changeWorkspace, scopeA)}>
        Switch workspace
      </button>
      <button onClick={() => guard.request(changeOrganization, scopeA)}>
        Switch organization
      </button>
      <button onClick={() => guard.request(signOut)}>Sign out</button>
      <button onClick={() => guard.request(changeWorkspace, scopeB)}>
        Other workspace action
      </button>
    </>
  );
}
function scopeGuardFixture() {
  const changeWorkspace = jest.fn(),
    changeOrganization = jest.fn(),
    signOut = jest.fn();
  let dirty = true,
    scope = scopeA;
  const element = () => (
    <ProcessEditsGuard copy={designEn}>
      <ScopeGuardHarness
        {...{ dirty, scope, changeWorkspace, changeOrganization, signOut }}
      />
    </ProcessEditsGuard>
  );
  let tree: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(element());
  });
  mounted.push(tree!);
  const click = (label: string) =>
    act(() =>
      tree.root
        .findAllByType("button")
        .find((node) => text(node) === label)!
        .props.onClick(),
    );
  return {
    tree: tree!,
    click,
    changeWorkspace,
    changeOrganization,
    signOut,
    update: (nextDirty: boolean, nextScope = scopeA) =>
      act(() => {
        dirty = nextDirty;
        scope = nextScope;
        tree.update(element());
      }),
  };
}

test("workspace and organization switches plus sign-out wait for an explicit discard choice", () => {
  const f = scopeGuardFixture();
  for (const label of ["Switch workspace", "Switch organization", "Sign out"]) {
    f.click(label);
    expect(f.tree.root.findAllByProps({ role: "alertdialog" })).toHaveLength(1);
    expect(f.changeWorkspace).not.toHaveBeenCalled();
    expect(f.changeOrganization).not.toHaveBeenCalled();
    expect(f.signOut).not.toHaveBeenCalled();
    f.click(designEn.stayAction);
    expect(f.tree.root.findAllByProps({ role: "alertdialog" })).toHaveLength(0);
  }
  f.click("Switch workspace");
  f.click(designEn.leaveAction);
  expect(f.changeWorkspace).toHaveBeenCalledTimes(1);
  expect(f.changeOrganization).not.toHaveBeenCalled();
  expect(f.signOut).not.toHaveBeenCalled();
});

test("scope guard ignores another workspace and dirty teardown cancels a stale departure", () => {
  const f = scopeGuardFixture();
  f.click("Other workspace action");
  expect(f.changeWorkspace).toHaveBeenCalledTimes(1);
  expect(f.tree.root.findAllByProps({ role: "alertdialog" })).toHaveLength(0);
  f.click("Sign out");
  expect(f.tree.root.findAllByProps({ role: "alertdialog" })).toHaveLength(1);
  f.update(false);
  expect(f.tree.root.findAllByProps({ role: "alertdialog" })).toHaveLength(0);
  expect(f.signOut).not.toHaveBeenCalled();
  f.click("Sign out");
  expect(f.signOut).toHaveBeenCalledTimes(1);
  f.update(true, scopeB);
  f.click("Switch organization");
  expect(f.changeOrganization).toHaveBeenCalledTimes(1);
  expect(f.tree.root.findAllByProps({ role: "alertdialog" })).toHaveLength(0);
  f.click("Other workspace action");
  expect(f.changeWorkspace).toHaveBeenCalledTimes(1);
  expect(f.tree.root.findAllByProps({ role: "alertdialog" })).toHaveLength(1);
});

function schemaControls(tree: TestRenderer.ReactTestRenderer, label: string) {
  const schema = tree.root
    .findAllByType("fieldset")
    .find((node) =>
      node.findAllByType("legend").some((legend) => text(legend) === label),
    )!;
  const fieldNames = () =>
    schema.findAll(
      (node) =>
        node.type === "div" &&
        node.props["data-field"] &&
        node.findAllByType("label").some((l) => text(l) === editorEn.fieldName),
    );
  return {
    schema,
    add: () =>
      act(() =>
        schema
          .findAllByType("button")
          .filter((node) => text(node) === editorEn.addField)
          .at(-1)!
          .props.onClick(),
      ),
    rename: (index: number, value: string, apply = true) => {
      act(() =>
        fieldNames()
          [index]!.findByType("input")
          .props.onChange({ target: { value } }),
      );
      if (apply)
        act(() =>
          fieldNames()
            [index]!.findAllByType("button")
            .find((node) => text(node) === editorEn.renameField)!
            .props.onClick(),
        );
    },
    name: (index: number) => fieldNames()[index]!.findByType("input"),
    nameField: (index: number) => fieldNames()[index]!,
    type: (index: number, value: string) =>
      act(() =>
        schema
          .findAllByType("select")
          [index]!.props.onChange({ target: { value } }),
      ),
    required: (index: number, checked: boolean) =>
      act(() =>
        schema
          .findAllByType("input")
          .filter((node) => node.props.type === "checkbox")
          [index]!.props.onChange({ target: { checked } }),
      ),
  };
}

test("guided schemas support nested objects/lists, optional fields and duplicate rename recovery", async () => {
  const f = fixture({ ...structuredClone(designUiReview), candidate: null });
  f.click(editorEn.create);
  f.pickAction();
  let schema = schemaControls(f.tree, editorEn.outputSchema);
  schema.add();
  schemaControls(f.tree, editorEn.outputSchema).rename(0, "profile");
  schemaControls(f.tree, editorEn.outputSchema).type(0, "object");
  // Both buttons are scoped to this step's output schema. First is nested;
  // last adds a sibling at the root.
  schema = schemaControls(f.tree, editorEn.outputSchema);
  act(() =>
    schema.schema
      .findAllByType("button")
      .filter((node) => text(node) === editorEn.addField)[0]!
      .props.onClick(),
  );
  schemaControls(f.tree, editorEn.outputSchema).rename(1, "name");
  schemaControls(f.tree, editorEn.outputSchema).add();
  schemaControls(f.tree, editorEn.outputSchema).rename(2, "tags");
  schemaControls(f.tree, editorEn.outputSchema).type(2, "array");
  schemaControls(f.tree, editorEn.outputSchema).required(2, false);
  schemaControls(f.tree, editorEn.outputSchema).rename(2, "profile", false);
  const invalid = schemaControls(f.tree, editorEn.outputSchema);
  expect(invalid.name(2).props.value).toBe("profile");
  expect(invalid.name(2).props["aria-invalid"]).toBe(true);
  expect(
    invalid
      .nameField(2)
      .findAllByType("button")
      .find((node) => text(node) === editorEn.renameField)!.props.disabled,
  ).toBe(true);
  expect(f.button(editorEn.save).props.disabled).toBe(true);
  f.openNode("finish");
  f.openNode("action_1");
  expect(
    schemaControls(f.tree, editorEn.outputSchema).name(2).props.value,
  ).toBe("profile");
  schemaControls(f.tree, editorEn.outputSchema).rename(2, "labels");
  expect(f.button(editorEn.save).props.disabled).toBe(false);
  await f.save();
  const output = f.updateCandidate.mock.calls[0]![1].steps.find(
    (s: { type: string }) => s.type === "action",
  ).outputSchema;
  expect(output).toEqual({
    type: "object",
    properties: {
      profile: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      labels: { type: "array", items: { type: "string" } },
    },
    required: ["profile"],
    additionalProperties: false,
  });
});

test("removing a schema field preserves unfinished renames of its surviving siblings", () => {
  const f = fixture({ ...structuredClone(designUiReview), candidate: null });
  f.click(editorEn.create);
  f.pickAction();
  schemaControls(f.tree, editorEn.outputSchema).add();
  schemaControls(f.tree, editorEn.outputSchema).add();
  schemaControls(f.tree, editorEn.outputSchema).add();
  schemaControls(f.tree, editorEn.outputSchema).rename(
    1,
    "middle_draft",
    false,
  );
  schemaControls(f.tree, editorEn.outputSchema).rename(2, "last_draft", false);
  act(() =>
    schemaControls(f.tree, editorEn.outputSchema)
      .schema.findAllByType("button")
      .find(
        (node) =>
          node.props["aria-label"] === `${editorEn.removeField}: field_1`,
      )!
      .props.onClick(),
  );
  expect(
    schemaControls(f.tree, editorEn.outputSchema).name(0).props.value,
  ).toBe("middle_draft");
  expect(
    schemaControls(f.tree, editorEn.outputSchema).name(1).props.value,
  ).toBe("last_draft");
  expect(f.button(editorEn.save).props.disabled).toBe(true);
});

test("an incomplete process name does not prevent editing an otherwise valid guided schema", () => {
  const f = fixture();
  f.openRoot();
  f.change(editorEn.name, "");
  expect(() =>
    schemaControls(f.tree, editorEn.outputSchema).add(),
  ).not.toThrow();
  expect(f.button(editorEn.save).props.disabled).toBe(true);
});

function RegisteredEditor({ dirty }: { dirty: boolean }) {
  const guard = useProcessEditsGuard();
  React.useEffect(() => guard.register(scopeA, dirty), [guard, dirty]);
  return <span>Local editor</span>;
}
test("real shell routes workspace, organization and sign-out selections through the mounted editor guard", () => {
  const logout = jest.fn();
  mockAdmin.setSelectedWorkspace.mockClear();
  mockAdmin.setSelectedOrganization.mockClear();
  let dirty = true;
  const element = () => (
    <ConsoleShell
      logout={logout}
      refresh={() => {}}
      busy={false}
      refreshing={false}
    >
      <RegisteredEditor dirty={dirty} />
    </ConsoleShell>
  );
  let tree: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(element());
  });
  mounted.push(tree!);
  const click = (label: string) =>
    act(() =>
      tree.root
        .findAllByType("button")
        .find((node) => text(node) === label)!
        .props.onClick(),
    );
  const currentItem = tree!.root
    .findAllByType("button")
    .find(
      (node) =>
        node.props["data-menu-item"] && text(node) === "TETEST workspace",
    )!;
  act(() => currentItem.props.onClick());
  expect(mockAdmin.setSelectedWorkspace).not.toHaveBeenCalled();
  expect(tree!.root.findAllByProps({ role: "alertdialog" })).toHaveLength(0);
  click("SeSecond workspace");
  expect(mockAdmin.setSelectedWorkspace).not.toHaveBeenCalled();
  click(designEn.stayAction);
  expect(mockAdmin.setSelectedWorkspace).not.toHaveBeenCalled();
  click("SeSecond workspace");
  click(designEn.leaveAction);
  expect(mockAdmin.setSelectedWorkspace).toHaveBeenCalledWith(
    "second_workspace",
  );
  click("Second organization");
  expect(mockAdmin.setSelectedOrganization).not.toHaveBeenCalled();
  click(designEn.leaveAction);
  expect(mockAdmin.setSelectedOrganization).toHaveBeenCalledWith("second_org");
  click("Sign out");
  expect(logout).not.toHaveBeenCalled();
  click(designEn.stayAction);
  dirty = false;
  act(() => tree.update(element()));
  click("Sign out");
  expect(logout).toHaveBeenCalledTimes(1);
});

test("review puts manually appended actions before their result and branches before downstream consumers", () => {
  const manual = addStep(
    createWorkflow(designUiCapabilities),
    "action",
    designUiCapabilities,
  );
  expect(manual.steps.map((step) => step.id)).toEqual(["finish", "action_1"]);
  expect(processReviewOrder(manual).map((step) => step.id)).toEqual([
    "action_1",
    "finish",
  ]);
  const branched = structuredClone(designUiReview.candidate!);
  if (branched.kind !== "workflow") throw Error("workflow expected");
  branched.steps.reverse();
  expect(processReviewOrder(branched).map((step) => step.id)).toEqual([
    "lookup",
    "check",
    "explain",
    "finish",
  ]);
  branched.steps.push({ id: "unreachable", type: "return", output: {} });
  expect(processReviewOrder(branched)).toHaveLength(branched.steps.length);
});

test("mounted designer registers its actual dirty canvas with the shell and clears registration after discard", () => {
  mockAdmin.setSelectedWorkspace.mockClear();
  const f = workspaceFixture(false, true);
  f.edit();
  f.click("SeSecond workspace");
  expect(mockAdmin.setSelectedWorkspace).not.toHaveBeenCalled();
  expect(f.tree.root.findAllByProps({ role: "alertdialog" })).toHaveLength(1);
  f.click(designEn.stayAction);
  f.click(editorEn.reset);
  act(() =>
    f.tree.root
      .findByProps({ "aria-label": `Confirm ${editorEn.reset}` })
      .props.onClick(),
  );
  f.click("SeSecond workspace");
  expect(mockAdmin.setSelectedWorkspace).toHaveBeenCalledWith(
    "second_workspace",
  );
  expect(f.tree.root.findAllByProps({ role: "alertdialog" })).toHaveLength(0);
});

test("guided schema root stays an object while property value types remain editable", () => {
  const f = fixture({ ...structuredClone(designUiReview), candidate: null });
  f.click(editorEn.create);
  f.pickAction();
  expect(
    schemaControls(f.tree, editorEn.outputSchema).schema.findAllByType(
      "select",
    ),
  ).toHaveLength(0);
  schemaControls(f.tree, editorEn.outputSchema).add();
  const selectors = schemaControls(
    f.tree,
    editorEn.outputSchema,
  ).schema.findAllByType("select");
  expect(selectors).toHaveLength(1);
  expect(
    selectors[0]!.findAllByType("option").map((option) => option.props.value),
  ).toEqual(expect.arrayContaining(["string", "object", "array"]));
});

test("negative test scenarios identify missing failure codes and duplicate case IDs before run", () => {
  const scenario = newCaseDraft("failure", 1);
  let value = JSON.stringify({
    genericModelId: "test_model",
    cases: [scenario],
  });
  const element = () => (
    <SuiteEditor
      value={value}
      onChange={() => {}}
      capabilities={designUiCapabilities}
      version={null}
      tools={null}
      disabled={false}
      language="en"
    />
  );
  let tree: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(element());
  });
  mounted.push(tree!);
  const field = (label: string) =>
    tree.root.findAll(
      (node) =>
        node.type === "div" &&
        node.props["data-field"] &&
        node.findAllByType("label").some((l) => text(l) === label),
    )[0]!;
  for (const label of [testEn.configuredCode, testEn.genericCode]) {
    expect(field(label).findByType("input").props["aria-invalid"]).toBe(true);
    expect(text(field(label))).toContain(testEn.requiredField);
  }
  expect(text(tree!.root)).toContain(testEn.invalidField);
  scenario.configuredCode = "process_action_failed";
  scenario.genericCode = "process_action_failed";
  value = JSON.stringify({
    genericModelId: "test_model",
    cases: [scenario, { ...scenario }],
  });
  act(() => tree.update(element()));
  expect(text(tree!.root)).toContain(testEn.duplicateIds);
  value = JSON.stringify({
    comparisonMode: "configured_only",
    genericModelId: "",
    cases: [scenario],
  });
  act(() => tree.update(element()));
  expect(tree!.root.findAllByType("label").map(text)).not.toContain(
    testEn.genericCode,
  );
  expect(
    field(testEn.configuredCode).findByType("input").props["aria-invalid"],
  ).toBe(false);
});

test.each(["review", "conversation"] as const)(
  "chosen %s survives the first proposal and verified session URL promotion/remount",
  (view) => {
    const first = workspaceFixture(true, false, {
      holdPromotion: true,
      noCandidate: true,
    });
    first.click(designEn[view]);
    expect(mockNavigate).not.toHaveBeenCalled();
    const completed = structuredClone(designUiReview);
    completed.revision++;
    completed.reviewDigest = "e".repeat(64);
    first.updateReview(completed);
    expect(
      first.tree.root
        .findAllByProps({ role: "tab" })
        .find((tab) => text(tab) === designEn[view])!.props["aria-selected"],
    ).toBe(true);
    first.settlePromotion();
    const promotion = mockNavigate.mock.calls.at(-1)![0];
    const carried = designSearchSchema.parse(promotion.search);
    expect(carried).toEqual({ sessionId: designUiReview.id, view });
    expect(promotion.replace).toBe(true);
    expect(first.client.updateCandidate).not.toHaveBeenCalled();
    act(() => first.tree.unmount());
    const remounted = workspaceFixture(false, false, {
      initialView: carried.view,
    });
    expect(
      remounted.tree.root
        .findAllByProps({ role: "tab" })
        .find((tab) => text(tab) === designEn[view])!.props["aria-selected"],
    ).toBe(true);
    expect(remounted.client.updateCandidate).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  },
);

test("carried views need a verified matching session and never change the new-process canvas default", () => {
  expect(designSearchSchema.parse({})).toEqual({});
  expect(designSearchSchema.safeParse({ view: "review" }).success).toBe(false);
  expect(
    designSearchSchema.safeParse({
      sessionId: designUiReview.id,
      view: "invalid",
    }).success,
  ).toBe(false);
  const fresh = workspaceFixture(true, false, { initialView: "review" });
  expect(
    fresh.tree.root
      .findAllByProps({ role: "tab" })
      .find((tab) => text(tab) === designEn.canvas)!.props["aria-selected"],
  ).toBe(true);
  const foreign = workspaceFixture(false, false, {
    initialView: "review",
    foreignWorkspace: true,
  });
  expect(
    foreign.tree.root
      .findAllByProps({ role: "tab" })
      .find((tab) => text(tab) === designEn.canvas)!.props["aria-selected"],
  ).toBe(true);
  const pendingRead = workspaceFixture();
  const pendingSnapshot = {
    ...pendingRead.client.getSnapshot(),
    review: null,
    capabilities: null,
  };
  const client = {
    ...pendingRead.client,
    getSnapshot: () => pendingSnapshot,
  } as ProcessDesignClient;
  let unverified: TestRenderer.ReactTestRenderer;
  act(() => {
    unverified = TestRenderer.create(
      <DesignWorkspace
        client={client}
        copy={designEn}
        language="en"
        initialView="review"
      />,
    );
  });
  mounted.push(unverified!);
  expect(
    unverified!.root
      .findAllByProps({ role: "tab" })
      .find((tab) => text(tab) === designEn.canvas)!.props["aria-selected"],
  ).toBe(true);
});

test("members see that the AI budget isn't set up and can't send before any request", () => {
  const render = (budgetReady: boolean) => {
    const base = workspaceFixture(false, false, {
      initialView: "conversation",
    });
    const snapshot = {
      ...base.client.getSnapshot(),
      capabilities: { ...designUiCapabilities, budgetReady },
      composer: "Make me a process",
    };
    const client = {
      ...base.client,
      canSend: true,
      getSnapshot: () => snapshot,
    } as ProcessDesignClient;
    let tree: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <ProcessHostContext.Provider
          value={{ adminLinks: "none", personalOnly: true }}
        >
          <DesignWorkspace
            client={client}
            copy={{ ...designEn, budget: designEn.budgetMember }}
            language="en"
            initialView="conversation"
          />
        </ProcessHostContext.Provider>,
      );
    });
    mounted.push(tree!);
    const send = tree!.root
      .findAllByType("button")
      .find((node) => text(node) === designEn.send)!;
    return { content: text(tree!.root), send };
  };
  const blocked = render(false);
  expect(blocked.content).toContain(designEn.budgetMember);
  expect(blocked.content).not.toContain(designEn.setUpLimits);
  expect(blocked.send.props.disabled).toBe(true);
  const ready = render(true);
  expect(ready.content).not.toContain(designEn.budgetMember);
  expect(ready.send.props.disabled).toBe(false);
});

test("the admin sidebar groups pages as Services, AI, Processes, People and Settings with the app link last", () => {
  let tree: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <ConsoleShell
        logout={() => {}}
        refresh={() => {}}
        busy={false}
        refreshing={false}
      >
        <span>Page</span>
      </ConsoleShell>,
    );
  });
  mounted.push(tree!);
  const nav = tree!.root.findByProps({ "aria-label": "Navigation" });
  const links = nav.findAllByType("a").map((a) => a.props.href ?? a.props.to);
  expect(links).toEqual([
    "/",
    "/services",
    "/plugins",
    "/mcp",
    "/providers",
    "/routing",
    "/usage",
    "/skills",
    "/processes",
    "/loops",
    "/people",
    "/workspaces",
    "/auth-providers",
    "/hosted",
    "/audit",
    "/settings",
  ]);
  const json = JSON.stringify(tree!.toJSON());
  for (const label of ["Services", "AI", "Processes", "People", "Settings"])
    expect(json).toContain(label);
  const anchors = tree!.root.findAllByType("a");
  const back = anchors.findIndex(
    (a) => a.props.href === "/" && text(a) === "Back to app",
  );
  const lastNav = anchors.findIndex((a) => a.props.to === "/settings");
  expect(back).toBeGreaterThan(lastNav);
});
