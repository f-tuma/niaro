import {
  checkProgram,
  programText,
  splitReply,
} from "../packages/openui-library/program";
import { generativeUiInstructions } from "../packages/openui-library/prompt";
import {
  GENERATIVE_UI_COMPONENTS,
  GENERATIVE_UI_LIMITS,
} from "../packages/openui-library/spec";
import { followUpMessage } from "../packages/openui-library/follow-up";
import { MessageSchema } from "../packages/protocol";
import {
  GENERATIVE_UI_PROFILE,
  GeneratedUiSchema,
} from "../packages/protocol/generative-ui";
import {
  messageDelivery,
  messageForClient,
} from "../packages/protocol/message-delivery";

const valid = `root = Stack([h, kpis, t, f, links])
h = Heading("TEST Sales", "l")
kpis = Row([Metric("TEST Q3", 120, "k CZK", "+12 %", "success"), Metric("TEST Orders", 34)])
t = Table(["Branch", "Revenue"], [["TEST Prague", 520], ["TEST Brno", null]])
f = Form("find", [TextField("name", "Name"), Checkbox("urgent", "Urgent")], Button("Find", @ToAssistant("Find the person")))
links = Buttons([Button("Docs", @OpenUrl("https://example.test/help"))])`;

test("a valid program is admitted and normalized for both renderers", () => {
  const checked = checkProgram(valid);
  expect(checked).toMatchObject({ ok: true, issues: [] });
  if (!checked.ok) throw Error("refused");
  expect(checked.program).toBe(valid.replace("Table([", "Table([").trim());
  expect(checkProgram(checked.program)).toMatchObject({
    ok: true,
    program: checked.program,
  });
  expect(programText(checked.root)).toContain("TEST Prague");
});

test("unknown components, wrong nesting and empty required props are dropped", () => {
  const checked = checkProgram(
    `root = Stack([Text("TEST kept"), Foo("x"), TextField("loose", "Loose"), Section("S", [Tabs([Tab("a", [Text("b")])])]), Text(@Count([1]))])`,
  );
  if (!checked.ok) throw Error("refused");
  expect(checked.program).toBe(
    'root = Stack([Text("TEST kept"), Section("S", [])])',
  );
  expect(checked.issues.join("\n")).toMatch(/Unknown component "Foo"/);
  expect(checked.issues).toEqual(
    expect.arrayContaining([
      "TextField cannot be placed in Stack",
      "Tabs cannot be placed in Section",
      "Text: @Count is not available",
    ]),
  );
});

test.each([
  [`root = Stack([Text(q.x)])\nq = Query("tool", {}, {x: 1})`],
  [`root = Stack([Button("Go", @Run(m))])\nm = Mutation("create", {})`],
])("data fetching refuses the whole program (%#)", (source) => {
  expect(checkProgram(source)).toEqual({
    ok: false,
    issues: ["Query and Mutation are not supported"],
  });
});

test.each([
  ['Button("Bad", @OpenUrl("javascript:alert(1)"))'],
  ['Button("Bad", @OpenUrl("ftp://example.test"))'],
  ['Button("Bad", @OpenUrl("https://" + $host))'],
  ['Button("Bad", @Delete("everything"))'],
  ['Link("Bad", "data:text/html,x")'],
  ['Link("Bad", "https://user:secret@example.test")'],
])("an unsafe link or action is not shown: %s", (control) => {
  const checked = checkProgram(`root = Stack([Text("TEST kept"), ${control}])`);
  if (!checked.ok) throw Error("refused");
  expect(checked.program).toBe('root = Stack([Text("TEST kept")])');
  expect(checked.issues.length).toBeGreaterThan(0);
});

test("follow-ups, local state and checked links are the only actions kept", () => {
  const checked = checkProgram(
    `$view = "a"
root = Stack([Text($view == "a" ? "A" : "B"), Buttons([Button("B", @Set($view, "b")), Button("Reset", @Reset($view)), Button("Ask", Action([@OpenUrl("https://example.test"), @ToAssistant("TEST explain")]))])])`,
  );
  expect(checked).toMatchObject({ ok: true, issues: [] });
  if (checked.ok) expect(checked.program.split("\n")[0]).toBe('$view = "a"');
});

test("size caps refuse oversized programs and bound long content", () => {
  expect(
    checkProgram(
      `root = Stack([Text("${"x".repeat(GENERATIVE_UI_LIMITS.characters)}")])`,
    ),
  ).toMatchObject({ ok: false });
  const many = Array.from(
    { length: GENERATIVE_UI_LIMITS.nodes + 1 },
    (_, i) => `Text("t${i}")`,
  );
  expect(checkProgram(`root = Stack([${many.join(", ")}])`)).toEqual({
    ok: false,
    issues: [
      `The program has more than ${GENERATIVE_UI_LIMITS.nodes} components`,
    ],
  });
  const rows = Array.from({ length: 80 }, (_, i) => `["r${i}", ${i}]`);
  const table = checkProgram(
    `root = Stack([Table(["A", "B"], [${rows.join(", ")}])])`,
  );
  if (!table.ok) throw Error("refused");
  expect(table.program).toContain('["r49", 49]');
  expect(table.program).not.toContain('["r50", 50]');
  expect(checkProgram('x = Text("no root")')).toMatchObject({ ok: false });
  expect(checkProgram("root = Stack([])")).toMatchObject({ ok: false });
});

test("a reply splits into Markdown text and its first openui-lang fence", () => {
  expect(
    splitReply(
      'Sales grew.\n\n```openui-lang\nroot = Stack([Text("a")])\n```\n\n```js\nkept()\n```\n```openui-lang\nroot = Stack([Text("b")])\n```',
    ),
  ).toEqual({
    text: "Sales grew.\n\n```js\nkept()\n```",
    program: 'root = Stack([Text("a")])',
  });
  expect(splitReply("Just text.")).toEqual({ text: "Just text." });
  expect(splitReply('root = Stack([Text("bare")])')).toEqual({
    text: "",
    program: 'root = Stack([Text("bare")])',
  });
});

test("a follow-up carries only the visible words and answers", () => {
  expect(
    followUpMessage({
      message: "Find the person",
      formName: "find",
      formState: {
        find: {
          // Edited first, shown second: answers follow the shown order.
          urgent: { value: true, componentType: "Checkbox" },
          name: { value: "TEST Jana", componentType: "TextField" },
          empty: { value: "  ", componentType: "TextField" },
        },
      },
      fields: new Map([
        ["find/name", { label: "Name", kind: "text" }],
        ["find/urgent", { label: "Spěchá", kind: "checkbox" }],
      ]),
      language: "cs",
    }),
  ).toBe("Find the person\nName: TEST Jana\nSpěchá: ano");
});

test("generated UI is negotiated and belongs only to assistant answers", () => {
  const ui = GeneratedUiSchema.parse({
    type: "openui.program",
    version: 1,
    library: "niaro-ui@1",
    program: 'root = Stack([Text("a")])',
  });
  const message = MessageSchema.parse({
    id: "TEST-m",
    role: "assistant",
    text: "TEST answer",
    ui,
  });
  expect(
    messageForClient(message, messageDelivery(new URLSearchParams())),
  ).toEqual({ id: "TEST-m", role: "assistant", text: "TEST answer" });
  expect(
    messageForClient(
      message,
      messageDelivery(new URLSearchParams({ ui: GENERATIVE_UI_PROFILE })),
    ),
  ).toEqual(message);
  expect(MessageSchema.safeParse({ ...message, role: "user" }).success).toBe(
    false,
  );
});

test("instructions are built locally from the shared library without network or telemetry", () => {
  const fetch = jest.fn();
  const original = globalThis.fetch;
  const opted = process.env.OPENUI_RUNTIME_TELEMETRY_ENABLED;
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  // Even a server that opts in to OpenUI's runtime telemetry sends nothing.
  process.env.OPENUI_RUNTIME_TELEMETRY_ENABLED = "1";
  try {
    const prompt = generativeUiInstructions();
    for (let i = 0; i < 50; i++) checkProgram(valid);
    expect(prompt).not.toContain("]]>openui:config");
    expect(prompt).toContain("```openui-lang");
    expect(prompt).not.toMatch(/hidden data|compose_card/);
    for (const component of GENERATIVE_UI_COMPONENTS)
      expect(prompt).toContain(`${component.name}(`);
    expect(prompt).not.toMatch(/Query\(|Mutation\(|@Run/);
    expect(process.env.OPENUI_TELEMETRY_DISABLED).toBe("1");
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = original;
    if (opted === undefined)
      delete process.env.OPENUI_RUNTIME_TELEMETRY_ENABLED;
    else process.env.OPENUI_RUNTIME_TELEMETRY_ENABLED = opted;
  }
});
