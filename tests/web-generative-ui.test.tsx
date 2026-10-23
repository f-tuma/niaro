import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { GeneratedUi } from "../apps/server-admin/web/app/generative-ui";
import { splitReply } from "../packages/openui-library/program";

// Charts draw with recharts, which Jest cannot parse; their frame is ours.
jest.mock("recharts", () =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule(),
);
jest.mock(
  "@admin/components/ui/chart",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
// Radix Select needs a DOM; its host keeps the handlers the page passes.
jest.mock(
  "@admin/components/ui/select",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
jest.mock("../apps/server-admin/web/app/context", () => ({
  useApp: () => ({ language: "cs" }),
}));

const open = jest.fn();
beforeAll(() => {
  Object.defineProperty(globalThis, "window", {
    value: globalThis,
    configurable: true,
  });
  globalThis.open = open as unknown as typeof globalThis.open;
});
beforeEach(() => open.mockReset());

/** Visible text; Czech digit groups use a no-break space. */
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string"
    ? node.replace(/\u00a0/g, " ")
    : node.children.map(text).join("");
const hosts = (root: ReactTestInstance, type: string) =>
  root.findAll((node) => node.type === type);
function button(root: ReactTestInstance, label: string) {
  const found = hosts(root, "button").filter(
    (node) => text(node) === label || node.props["aria-label"] === label,
  );
  if (!found.length) throw new Error(`No button "${label}"`);
  return found[0]!;
}
const click = (root: ReactTestInstance, label: string) =>
  act(async () => button(root, label).props.onClick());

async function render(
  program: string,
  options: { streaming?: boolean; disabled?: boolean } = {},
) {
  const onFollowUp = jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <GeneratedUi program={program} onFollowUp={onFollowUp} {...options} />,
    );
  });
  await act(async () => {});
  return { renderer, root: renderer.root, onFollowUp };
}

test("an answer draws its headings, numbers, records and chart with the console's parts", async () => {
  const { root } = await render(
    [
      "root = Stack([h, Row([m]), t, c, l, d])",
      'h = Heading("Přehled týdne", "l")',
      'm = Metric("Tržby", 1200.5, "Kč", "+12 % proti minulému týdnu", "success")',
      't = Table(["Klient", "Částka"], [["Beta", 5], ["Alfa", 10]], true)',
      'c = BarChart(["Po", "Út", "St"], [Series("Tržby", [3, 5, 4])])',
      'l = List([ListItem("Faktura 12", "Po splatnosti", "3. 10.", Badge("Pozdě", "danger"), @ToAssistant("Ukaž fakturu 12"))])',
      'd = Details([Detail("E-mail", "jan@example.com"), Detail("Web", "https://example.com/jan"), Detail("Telefon", "+420 777 123 456"), Detail("Poznámka", "javascript:alert(1)")])',
    ].join("\n"),
  );
  expect(text(hosts(root, "h3")[0]!)).toBe("Přehled týdne");
  expect(text(root)).toContain("1 200,5");
  expect(text(root)).toContain("+12 % proti minulému týdnu");
  // Numbers sit right in their column and sort locally.
  const cells = () => hosts(root, "td").map(text);
  expect(cells()).toEqual(["Beta", "5", "Alfa", "10"]);
  await click(root, "Seřadit podle Částka");
  await click(root, "Seřadit podle Částka");
  expect(cells()).toEqual(["Alfa", "10", "Beta", "5"]);
  await click(root, "Seřadit podle Klient");
  await click(root, "Seřadit podle Klient");
  expect(cells()).toEqual(["Beta", "5", "Alfa", "10"]);
  const amount = hosts(root, "th").find((th) => text(th) === "Částka")!;
  expect(amount.props.className.split(" ")).toContain("text-right");
  expect(amount.props["aria-sort"]).toBe("none");
  const chart = hosts(root, "figure")[0]!;
  expect(chart.props["aria-label"]).toBe("Sloupcový graf: Tržby: Po–St");
  expect(
    chart.findAll((node) => node.props["data-host"] === "ChartContainer"),
  ).toHaveLength(1);
  expect(text(hosts(root, "li")[0]!)).toContain("Pozdě");
  const links = Object.fromEntries(
    hosts(root, "a").map((a) => [text(a), a.props]),
  );
  expect(links["jan@example.com"]!.href).toBe("mailto:jan@example.com");
  expect(links["https://example.com/jan"]).toMatchObject({
    href: "https://example.com/jan",
    target: "_blank",
    rel: "noopener noreferrer",
  });
  expect(links["+420 777 123 456"]!.href).toBe("tel:+420777123456");
  expect(text(root)).toContain("javascript:alert(1)");
  expect(links["javascript:alert(1)"]).toBeUndefined();
});

test("a streamed reply is drawn as it grows and acts only once it is complete", async () => {
  const reply = [
    "Tady je přehled.",
    "```openui-lang",
    "root = Stack([h, m, b])",
    'h = Heading("Tržby")',
    'm = Metric("Tento týden", 1200, "Kč")',
    'b = Button("Podrobnosti", @ToAssistant("Ukaž podrobnosti"))',
    "```",
  ].join("\n");
  const upTo = (line: string) => reply.slice(0, reply.indexOf(line));
  const { renderer, root, onFollowUp } = await render(upTo('m = Metric("'), {
    streaming: true,
  });
  expect(text(root)).toContain("Tržby");
  expect(text(root)).not.toContain("Tento týden");
  expect(text(root)).not.toContain("Tady je přehled.");
  const update = (program: string, streaming: boolean) =>
    act(async () =>
      renderer.update(
        <GeneratedUi
          program={program}
          streaming={streaming}
          onFollowUp={onFollowUp}
        />,
      ),
    );
  await update(upTo('b = Button("'), true);
  expect(text(root)).toContain("Tento týden");
  expect(text(root)).toContain("1 200");
  expect(() => button(root, "Podrobnosti")).toThrow();
  await update(reply, true);
  expect(button(root, "Podrobnosti").props.disabled).toBe(true);
  await click(root, "Podrobnosti");
  expect(onFollowUp).not.toHaveBeenCalled();
  // The finished answer arrives admitted, without its prose.
  await update(splitReply(reply).program!, false);
  expect(text(root)).toContain("Tento týden");
  expect(button(root, "Podrobnosti").props.disabled).toBe(false);
  await click(root, "Podrobnosti");
  expect(onFollowUp).toHaveBeenCalledWith("Ukaž podrobnosti");
});

test("a form's answers go to the composer under their labels, after the required ones", async () => {
  const { root, onFollowUp } = await render(
    [
      "root = Stack([f])",
      'f = Form("kontakt", [n, d, s, c], Buttons([Button("Odeslat", @ToAssistant("Posílám údaje"), "primary"), Button("Zrušit", @ToAssistant("Nechci"), "primary")]))',
      'n = TextField("jmeno", "Jméno", "Celé jméno", "", true)',
      'd = DateField("datum", "Datum")',
      's = Select("typ", "Typ", ["Firma", "Osoba"])',
      'c = Checkbox("souhlas", "Souhlas")',
    ].join("\n"),
  );
  // One primary at most: the second one is outlined.
  expect(button(root, "Odeslat").props["data-variant"]).toBe("default");
  expect(button(root, "Zrušit").props["data-variant"]).toBe("outline");
  await click(root, "Odeslat");
  expect(onFollowUp).not.toHaveBeenCalled();
  expect(text(root)).toContain("Povinné");

  const [name, date] = hosts(root, "input");
  await act(async () => name!.props.onChange({ target: { value: "Jan" } }));
  await act(async () =>
    date!.props.onChange({ target: { value: "2026-10-24" } }),
  );
  const select = root.find(
    (node) => typeof node.props.onValueChange === "function",
  );
  await act(async () => select.props.onValueChange("Firma"));
  await click(root, "Odeslat");
  expect(onFollowUp).toHaveBeenCalledTimes(1);
  expect(onFollowUp).toHaveBeenLastCalledWith(
    "Posílám údaje\nJméno: Jan\nDatum: 2026-10-24\nTyp: Firma\nSouhlas: ne",
  );
  const checkbox = root.find(
    (node) => typeof node.props.onCheckedChange === "function",
  );
  await act(async () => checkbox.props.onCheckedChange(true));
  await click(root, "Odeslat");
  expect(onFollowUp).toHaveBeenLastCalledWith(
    "Posílám údaje\nJméno: Jan\nDatum: 2026-10-24\nTyp: Firma\nSouhlas: ano",
  );
});

test("a bound field quotes its value; a row's action and a bare button ask by their words", async () => {
  const { root, onFollowUp } = await render(
    [
      '$who = "Petr"',
      "root = Stack([f, l, b])",
      'f = Form("komu", [TextField("jmeno", "Komu", "", $who)], Button("Poslat", @ToAssistant("Pošli to")))',
      'l = List([ListItem("Faktura 12", "", "", null, @ToAssistant("Ukaž fakturu 12"))])',
      'b = Button("Co dál?")',
    ].join("\n"),
  );
  await click(root, "Poslat");
  expect(onFollowUp).toHaveBeenLastCalledWith("Pošli to\nKomu: Petr");
  await act(async () =>
    hosts(root, "input")[0]!.props.onChange({ target: { value: "Eva" } }),
  );
  await click(root, "Poslat");
  expect(onFollowUp).toHaveBeenLastCalledWith("Pošli to\nKomu: Eva");
  await click(root, "Faktura 12");
  expect(onFollowUp).toHaveBeenLastCalledWith("Ukaž fakturu 12");
  await click(root, "Co dál?");
  expect(onFollowUp).toHaveBeenLastCalledWith("Co dál?");
  expect(open).not.toHaveBeenCalled();
});

test("only http(s) addresses open, in a new tab without a referrer", async () => {
  const { root, onFollowUp } = await render(
    [
      "root = Stack([Buttons([a, b]), l, k])",
      'a = Button("Web", @OpenUrl("https://example.com/a"))',
      'b = Button("Skript", @OpenUrl("javascript:alert(1)"))',
      'l = Link("Návod", "https://example.com/navod")',
      'k = Link("Past", "javascript:alert(1)")',
    ].join("\n"),
  );
  await click(root, "Web");
  expect(open).toHaveBeenCalledWith(
    "https://example.com/a",
    "_blank",
    "noopener,noreferrer",
  );
  expect(() => button(root, "Skript")).toThrow();
  const links = hosts(root, "a");
  expect(links.map(text)).toEqual(["Návod"]);
  expect(links[0]!.props).toMatchObject({
    href: "https://example.com/navod",
    target: "_blank",
    rel: "noopener noreferrer",
  });
  expect(onFollowUp).not.toHaveBeenCalled();
});

test("while streaming, an unchecked link is still never drawn", async () => {
  const { root } = await render(
    'root = Stack([Link("Past", "javascript:alert(1)"), Text("Hotovo")])',
    { streaming: true },
  );
  expect(text(root)).toContain("Hotovo");
  expect(hosts(root, "a")).toHaveLength(0);
});

test("unknown components are dropped and the rest is shown; a broken program shows nothing", async () => {
  const { root } = await render(
    'root = Stack([Foo("tajné"), Text("Zbytek odpovědi")])',
  );
  expect(text(root)).toContain("Zbytek odpovědi");
  expect(text(root)).not.toContain("tajné");
  const broken = await render('root = Card([Text("Bez kořene")])');
  expect(broken.renderer.toJSON()).toBeNull();
});

test("a read-only chat shows the answer but nothing in it acts", async () => {
  const { root, onFollowUp } = await render(
    [
      "root = Stack([f, w])",
      'f = Form("kontakt", [TextField("jmeno", "Jméno")], Button("Odeslat", @ToAssistant("Posílám")))',
      'w = Button("Web", @OpenUrl("https://example.com"))',
    ].join("\n"),
    { disabled: true },
  );
  expect(button(root, "Odeslat").props.disabled).toBe(true);
  expect(hosts(root, "input")[0]!.props.disabled).toBe(true);
  await click(root, "Odeslat");
  await click(root, "Web");
  expect(onFollowUp).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});
