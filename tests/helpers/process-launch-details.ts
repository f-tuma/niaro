import { fireEvent, screen } from "@testing-library/react-native";
import { en, cs } from "../../packages/i18n";

/** The exact reviewed JSON sits behind the launcher's Details disclosure. */
export function processLaunchDetails(
  testID = "process-launch-input",
): ReturnType<typeof screen.getByTestId> {
  const names = new Set([en.processesDetails, cs.processesDetails]);
  for (const button of screen.queryAllByRole("button")) {
    if (screen.queryByTestId(testID)) break;
    if (names.has(button.props.accessibilityLabel)) fireEvent.press(button);
  }
  return screen.getByTestId(testID);
}
