import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { Markdown } from "../apps/server-admin/web/components/ui/markdown";
import { answerSummary } from "../apps/server-admin/web/app/chat-next/announce";

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
jest.mock(
  "@admin/components/ui/tooltip",
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
const labels = { copy: "Copy code", copied: "Copied" };

function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer.root;
}

test("headings are headings below the page title, on two steps", () => {
  const root = render(
    <Markdown text={"# Summary\n\n## Deals\n\n#### Owner\n\nText"} />,
  );
  expect(root.findAllByType("h1")).toHaveLength(0);
  expect(text(root.findByType("h2"))).toBe("Summary");
  expect(text(root.findByType("h3"))).toBe("Deals");
  expect(text(root.findByType("h5"))).toBe("Owner");
  expect(root.findAllByType("p").map(text)).toEqual(["Text"]);
});

test("a table's first row names its columns", () => {
  const root = render(
    <Markdown
      text={
        "| Deal | Amount |\n| --- | ---: |\n| Acme | 1 200 |\n| Beta | 300 |"
      }
    />,
  );
  const head = root.findByType("thead");
  const columns = head.findAllByType("th");
  expect(columns.map(text)).toEqual(["Deal", "Amount"]);
  expect(columns.every((cell) => cell.props.scope === "col")).toBe(true);
  expect(columns[1]!.props.className).toBe("text-right");
  const body = root.findByType("tbody");
  expect(body.findAllByType("tr")).toHaveLength(2);
  expect(body.findAllByType("th")).toHaveLength(0);
  expect(body.findAllByType("td").map(text)).toEqual([
    "Acme",
    "1 200",
    "Beta",
    "300",
  ]);
});

test("a code block copies exactly its text and says so for a moment", async () => {
  jest.useFakeTimers();
  const writeText = jest.fn(async () => {});
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText } },
    configurable: true,
  });
  const onCopied = jest.fn();
  try {
    const root = render(
      <Markdown
        text={'Run:\n\n```json\n{ "ok": true }\n```'}
        codeCopy={labels}
        onCopied={onCopied}
      />,
    );
    expect(text(root.findByType("pre"))).toBe('{ "ok": true }');
    const button = () => root.findByType("button");
    expect(button().props["aria-label"]).toBe("Copy code");
    await act(async () => button().props.onClick());
    expect(writeText).toHaveBeenCalledWith('{ "ok": true }');
    expect(onCopied).toHaveBeenCalledTimes(1);
    expect(button().props["aria-label"]).toBe("Copied");
    act(() => jest.advanceTimersByTime(1500));
    expect(button().props["aria-label"]).toBe("Copy code");
  } finally {
    jest.useRealTimers();
  }
});

test("without labels a code block has no copy action, as in generated UI", () => {
  const root = render(<Markdown text={"```\nx = 1\n```"} />);
  expect(text(root.findByType("pre"))).toBe("x = 1");
  expect(root.findAllByType("button")).toHaveLength(0);
});

test("the chat size is a variant of the renderer, not a restyle", () => {
  const chat = render(<Markdown text="Hi" size="chat" />);
  const slot = chat.find((node) => node.props["data-slot"] === "markdown");
  expect(slot.props["data-size"]).toBe("chat");
  expect(slot.props.className).toContain("data-[size=chat]:text-md");
  expect(slot.props.className).toContain("data-[size=chat]:leading-chat");
  const plain = render(<Markdown text="Hi" />);
  expect(
    plain.find((node) => node.props["data-slot"] === "markdown").props[
      "data-size"
    ],
  ).toBe("default");
});

test("HTML stays text and unsafe links stay text", () => {
  const root = render(
    <Markdown
      text={
        "<script>alert(1)</script>\n\n[x](javascript:alert(1)) [y](https://example.test)"
      }
    />,
  );
  expect(root.findAllByType("script")).toHaveLength(0);
  expect(text(root)).toContain("<script>alert(1)</script>");
  const links = root.findAllByType("a");
  expect(links.map((link) => link.props.href)).toEqual([
    "https://example.test/",
  ]);
});

test("the announcement gets the first paragraph as plain text", () => {
  expect(answerSummary("## Deals\n\nThree **open** deals.")).toBe(
    "Three open deals.",
  );
  expect(answerSummary("## Deals")).toBe("Deals");
  expect(
    answerSummary("Three **open** deals, see [CRM](https://x.test)."),
  ).toBe("Three open deals, see CRM.");
  expect(answerSummary("- first item\n- second")).toBe("first item");
  expect(answerSummary("")).toBe("");
  expect(answerSummary("a".repeat(400))).toHaveLength(300);
});
