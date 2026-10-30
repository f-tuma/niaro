import React from "react";
import { Modal, Text } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { DetailSheet } from "../apps/mobile/ScreenChrome";

jest.mock("../packages/ui/motion", () => ({
  ...jest.requireActual("../packages/ui/motion"),
  useReducedMotion: () => true,
}));

function touch(y: number, previousY: number, time: number) {
  const touchHistory = {
    numberActiveTouches: 1,
    indexOfSingleActiveTouch: 0,
    mostRecentTimeStamp: time,
    touchBank: [
      {
        touchActive: true,
        startPageX: 10,
        startPageY: 0,
        startTimeStamp: 0,
        currentPageX: 10,
        currentPageY: y,
        currentTimeStamp: time,
        previousPageX: 10,
        previousPageY: previousY,
        previousTimeStamp: 0,
      },
    ],
  };
  return {
    touchHistory,
    nativeEvent: {
      timestamp: time,
      touches: [{ pageX: 10, pageY: y }],
      changedTouches: [{ pageX: 10, pageY: y }],
    },
    persist() {},
  };
}

test.each(["handle", "scrim", "system-back", "accessibility", "swipe"])(
  "sheet %s dismissal closes without running its content action",
  (method) => {
    const close = jest.fn(),
      action = jest.fn();
    const view = render(
      <DetailSheet title="TEST confirmation" language="en" onClose={close}>
        <Text onPress={action}>TEST destructive content action</Text>
      </DetailSheet>,
    );
    if (method === "handle")
      fireEvent.press(view.getByRole("button", { name: "Close" }));
    if (method === "scrim")
      fireEvent(
        view.getByTestId("detail-sheet-scrim", { includeHiddenElements: true }),
        "responderRelease",
      );
    if (method === "system-back")
      fireEvent(view.UNSAFE_getByType(Modal), "requestClose");
    if (method === "accessibility")
      fireEvent(view.getByTestId("detail-sheet"), "accessibilityEscape");
    if (method === "swipe") {
      const header = view.getByTestId("detail-sheet-header");
      act(() => {
        header.props.onStartShouldSetResponderCapture(touch(0, 0, 1));
        header.props.onResponderMove(touch(100, 0, 100));
        header.props.onResponderRelease(touch(100, 100, 110));
      });
    }
    expect(close).toHaveBeenCalledTimes(1);
    expect(action).not.toHaveBeenCalled();
  },
);

test("small or upward sheet header drags leave it open", () => {
  const close = jest.fn();
  const view = render(
    <DetailSheet title="TEST sheet" language="cs" onClose={close}>
      <Text>TEST content</Text>
    </DetailSheet>,
  );
  const header = view.getByTestId("detail-sheet-header");
  for (const y of [8, -120]) {
    act(() => {
      header.props.onStartShouldSetResponderCapture(touch(0, 0, 1));
      header.props.onResponderMove(touch(y, 0, 100));
      header.props.onResponderRelease(touch(y, y, 110));
    });
  }
  expect(close).not.toHaveBeenCalled();
});
