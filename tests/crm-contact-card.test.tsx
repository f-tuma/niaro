import React from "react";
import { Linking } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { CrmContactResults } from "../packages/ui-catalog/CrmContactCard";
import { crmContactResult } from "../packages/test-fixtures";
import { translate } from "../packages/i18n";

test.each(["en", "cs"] as const)(
  "%s contact cards offer phone and email as explicit links only",
  (language) => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    const result = crmContactResult();
    const contact = result.contacts[0]!;
    const tr = translate(language);
    render(<CrmContactResults result={result} language={language} />);
    expect(screen.getByText(contact.name)).toBeTruthy();
    expect(screen.getByText(tr("crmContacts"))).toBeTruthy();
    expect(screen.getByText(tr("crmPhone"))).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(openURL).not.toHaveBeenCalled();
    fireEvent.press(
      screen.getByRole("link", {
        name: tr("contactCall").replace("{value}", contact.phone!),
      }),
    );
    expect(openURL).toHaveBeenLastCalledWith(
      `tel:${contact.phone!.replace(/[^+0-9]/g, "")}`,
    );
    fireEvent.press(
      screen.getByRole("link", {
        name: tr("contactWrite").replace("{value}", contact.email!),
      }),
    );
    expect(openURL).toHaveBeenLastCalledWith(`mailto:${contact.email}`);
    openURL.mockRestore();
    expect(screen.queryByText(translate(language)("crmMore"))).toBeNull();
  },
);

test("missing optional details do not produce blank rows, placeholders or invented values", () => {
  const result = {
    ...crmContactResult(),
    contacts: [{ id: "test-only", name: "TEST Name only" }],
  };
  const { rerender } = render(
    <CrmContactResults result={result} language="cs" />,
  );
  expect(screen.queryByText("Telefon")).toBeNull();
  expect(screen.queryByText("E-mail")).toBeNull();
  expect(screen.queryByText(/example.test/)).toBeNull();
  rerender(
    <CrmContactResults result={{ ...result, contacts: [] }} language="cs" />,
  );
  expect(screen.getByText(translate("cs")("crmEmpty"))).toBeTruthy();
  expect(screen.queryByText("TEST Name only")).toBeNull();
});

test("multiple results have separate identities and indicate truncation only when supplied", () => {
  const result = crmContactResult();
  result.contacts.push({
    id: "test-other",
    name: "TEST Other Person",
    email: "other@example.test",
  });
  result.hasMore = true;
  render(<CrmContactResults result={result} language="en" />);
  expect(screen.getByTestId("crm-contact-test-alex-novak")).toBeTruthy();
  expect(screen.getByTestId("crm-contact-test-other")).toBeTruthy();
  expect(screen.getByText(translate("en")("crmMore"))).toBeTruthy();
});
