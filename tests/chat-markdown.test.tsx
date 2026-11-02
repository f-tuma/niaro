import React from "react";
import { Linking, StyleSheet } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import {
  MarkdownCopyContext,
  MarkdownText,
} from "../packages/ui-catalog/MarkdownText";

test("chat renders headings, emphasis, nested lists, fenced code and GFM tables", () => {
  render(
    <MarkdownText
      text={
        "## Výsledek\n\n**Nalezeno** a *ověřeno*.\n\n- Kontakt\n  - Email\n\n~~~ts\nconst ok = true;\n~~~\n\n| Jméno | Stav |\n| --- | --- |\n| Jana | Hotovo |"
      }
    />,
  );
  expect(screen.getAllByRole("header")[0]!.children).toEqual(["Výsledek"]);
  expect(
    StyleSheet.flatten(screen.getByText("Nalezeno").props.style).fontWeight,
  ).toBe("600");
  expect(
    StyleSheet.flatten(screen.getByText("ověřeno").props.style).fontStyle,
  ).toBe("italic");
  for (const text of ["Kontakt", "Email", "const ok = true;", "Jana", "Hotovo"])
    expect(screen.getByText(text)).toBeTruthy();
  expect(screen.queryByText(/~~~|\*\*Nalezeno/)).toBeNull();
});

test.each([
  ["https://example.test/contact", "https://example.test/contact"],
  ["mailto:jane@example.test", "mailto:jane@example.test"],
  ["tel:+420777123456", "tel:+420777123456"],
])(
  "a supported Markdown link opens only on explicit press: %s",
  (url, expected) => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    render(<MarkdownText text={"[Kontakt](" + url + ")"} />);
    expect(open).not.toHaveBeenCalled();
    fireEvent.press(screen.getByRole("link"));
    expect(open.mock.calls).toEqual([[expected]]);
    open.mockRestore();
  },
);

test.each([
  "javascript:alert%281%29",
  "file:///private",
  "data:text/html,test",
])("unsupported Markdown links remain text and cannot execute: %s", (url) => {
  render(<MarkdownText text={"[Kontakt](" + url + ")"} />);
  expect(screen.getByText("Kontakt")).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
});

test("HTML and remote images remain passive text", () => {
  render(
    <MarkdownText
      text={
        '<script>alert("test")</script>\n\n![Fotografie](https://example.test/private.png)'
      }
    />,
  );
  expect(screen.getByText('<script>alert("test")</script>')).toBeTruthy();
  expect(screen.getByText("Fotografie")).toBeTruthy();
  expect(screen.queryByRole("image")).toBeNull();
});

// NIAR-266 chat reading.

test("headings take two steps and the first table row is a header row", () => {
  render(
    <MarkdownText
      text={
        "# Obchody\n\n#### Vlastník\n\n| Obchod | Částka |\n| --- | --- |\n| Acme | 1 200 |"
      }
    />,
  );
  const style = (text: string) =>
    StyleSheet.flatten(screen.getByText(text).props.style);
  expect(style("Obchody").fontSize).toBe(17);
  expect(style("Vlastník").fontSize).toBe(16);
  expect(style("Vlastník").marginTop).toBe(8);
  expect(screen.getByText("Obchod").props.accessibilityRole).toBe("header");
  expect(style("Obchod").fontWeight).toBe("600");
  expect(screen.getByText("Acme").props.accessibilityRole).toBeUndefined();
});

test("Copy code copies exactly the block and says so for a moment", async () => {
  jest.useFakeTimers();
  const copy = jest.fn(async () => {});
  try {
    render(
      <MarkdownCopyContext.Provider value={{ copy, language: "cs" }}>
        <MarkdownText text={"Spusť:\n\n~~~sh\nnpm test\n~~~"} />
      </MarkdownCopyContext.Provider>,
    );
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Kopírovat kód" }));
    });
    expect(copy.mock.calls).toEqual([["npm test"]]);
    expect(screen.getByRole("button", { name: "Zkopírováno" })).toBeTruthy();
    act(() => jest.advanceTimersByTime(1500));
    expect(screen.getByRole("button", { name: "Kopírovat kód" })).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});

test("without a clipboard from the app a code block has no copy action", () => {
  render(<MarkdownText text={"~~~\nx = 1\n~~~"} />);
  expect(screen.getByText("x = 1")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});
