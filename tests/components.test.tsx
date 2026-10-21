import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { InputRequestForm } from "../packages/ui-catalog/InputRequestForm";
import { WorkItemCard } from "../packages/ui-catalog/WorkItemCard";
import { choosePeter } from "../packages/test-fixtures";
test("render is passive, a required choice is validated, one explicit answer carries its revision", () => {
  const input = choosePeter().input,
    onAnswer = jest.fn();
  render(<InputRequestForm input={input} language="en" onAnswer={onAnswer} />);
  expect(onAnswer).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: "Send answer" }));
  expect(screen.getByText("Select a contact before sending.")).toBeTruthy();
  fireEvent.press(screen.getByRole("radio", { name: /Peter Novák/ }));
  fireEvent.press(screen.getByRole("button", { name: "Send answer" }));
  expect(onAnswer).toHaveBeenCalledWith("peter-novak", 1);
});
test("CS shared work card uses translated controls and no business side effects", () => {
  const fixture = choosePeter("cs"),
    onAnswer = jest.fn();
  render(<WorkItemCard {...fixture} language="cs" onAnswer={onAnswer} />);
  expect(screen.getByText("Čeká na tvůj vstup")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Odeslat odpověď" })).toBeTruthy();
  expect(onAnswer).not.toHaveBeenCalled();
});
test.each(["sending", "network_error"] as const)(
  "%s blocks submission",
  (state) => {
    const onAnswer = jest.fn();
    render(
      <InputRequestForm
        input={choosePeter().input}
        language="en"
        state={state}
        onAnswer={onAnswer}
      />,
    );
    fireEvent.press(screen.getByRole("radio", { name: /Peter Novák/ }));
    fireEvent.press(screen.getByRole("button"));
    expect(onAnswer).not.toHaveBeenCalled();
  },
);
test("revision update preserves the draft but requires review; external resolution explains closure", () => {
  const input = choosePeter().input,
    onAnswer = jest.fn();
  const { rerender } = render(
    <InputRequestForm input={input} language="en" onAnswer={onAnswer} />,
  );
  fireEvent.press(screen.getByRole("radio", { name: /Peter Novák/ }));
  rerender(
    <InputRequestForm
      input={{ ...input, revision: 2 }}
      language="en"
      onAnswer={onAnswer}
    />,
  );
  expect(
    screen.getByRole("radio", { name: /Peter Novák/ }).props.accessibilityState
      .checked,
  ).toBe(true);
  fireEvent.press(screen.getByRole("button", { name: "Send answer" }));
  expect(onAnswer).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: "Refresh" }));
  fireEvent.press(screen.getByRole("button", { name: "Send answer" }));
  expect(onAnswer).toHaveBeenCalledWith("peter-novak", 2);
  rerender(
    <InputRequestForm
      input={{
        ...input,
        revision: 3,
        status: "resolved",
        resolution: {
          source: "chat",
          selectedContactId: "peter-novak",
          reason: "Resolved elsewhere",
        },
      }}
      language="en"
      onAnswer={onAnswer}
    />,
  );
  expect(screen.queryByRole("button", { name: "Send answer" })).toBe(null);
  expect(screen.getByText(/Answer resolved by server/)).toBeTruthy();
});
