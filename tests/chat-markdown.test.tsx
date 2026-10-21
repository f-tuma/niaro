import React from "react";
import { Linking, StyleSheet } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { MarkdownText } from "../packages/ui-catalog/MarkdownText";

test("chat renders headings, emphasis, nested lists, fenced code and GFM tables", () => {
  render(
    <MarkdownText
      text={
        "## Výsledek\n\n**Nalezeno** a *ověřeno*.\n\n- Kontakt\n  - Email\n\n~~~ts\nconst ok = true;\n~~~\n\n| Jméno | Stav |\n| --- | --- |\n| Jana | Hotovo |"
      }
    />,
  );
  expect(screen.getByRole("header").children).toEqual(["Výsledek"]);
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
