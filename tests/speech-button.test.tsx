import React from "react";
import { render, fireEvent } from "@testing-library/react-native";
import { ReplySpeechButton } from "../packages/ui-catalog/ReplySpeechButton";
test("preparing speech can be cancelled, a live microphone disables playback", () => {
  const onPress = jest.fn();
  const ui = render(
    <ReplySpeechButton
      phase="loading"
      language="cs"
      disabled={false}
      onPress={onPress}
    />,
  );
  fireEvent.press(ui.getByRole("button", { name: "Zastavit předčítání" }));
  expect(onPress).toHaveBeenCalledTimes(1);
  ui.rerender(
    <ReplySpeechButton phase="idle" language="en" disabled onPress={onPress} />,
  );
  expect(ui.getByRole("button", { name: "Read reply aloud" })).toBeDisabled();
});
