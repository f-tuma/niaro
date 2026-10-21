import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Platform } from "react-native";
import {
  DateTimePickerAndroid,
  type AndroidNativeProps,
} from "@react-native-community/datetimepicker";
import { DateTimeFields } from "../packages/ui/DateTimeFields";
import { localDateTime } from "../packages/ui/local-date-time";

const initialValue = "2026-09-27T12:00:00.000Z";
const props = () => ({
  ...localDateTime(initialValue),
  initialValue,
  dateLabel: "Date",
  timeLabel: "Time",
  language: "en" as const,
  onDateChange: jest.fn(),
  onTimeChange: jest.fn(),
});
let originalPlatform: typeof Platform.OS;
beforeEach(() => {
  originalPlatform = Platform.OS;
  Object.defineProperty(Platform, "OS", {
    value: "android",
    configurable: true,
  });
});
afterEach(() => {
  Object.defineProperty(Platform, "OS", {
    value: originalPlatform,
    configurable: true,
  });
  jest.restoreAllMocks();
});

test("Android uses system date/time dialogs; dismissal is passive and each selection changes only its field", () => {
  const open = jest
    .spyOn(DateTimePickerAndroid, "open")
    .mockImplementation(() => {});
  const p = props();
  render(<DateTimeFields {...p} />);
  expect(open).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: /^Date:/ }));
  const datePicker = open.mock.calls[0]![0];
  expect(datePicker.mode).toBe("date");
  expect(datePicker.value.toISOString()).toBe(initialValue);
  act(() => datePicker.onDismiss?.());
  expect(p.onDateChange).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: /^Time:/ }));
  const timePicker = open.mock.calls[1]![0];
  expect(timePicker.mode).toBe("time");
  expect(timePicker.is24Hour).toBe(true);
  const selected = new Date(2026, 8, 27, 16, 35);
  act(() =>
    timePicker.onValueChange?.(
      { nativeEvent: { timestamp: selected.getTime(), utcOffset: 0 } },
      selected,
    ),
  );
  expect(p.onTimeChange).toHaveBeenCalledWith("16:35");
  expect(p.onDateChange).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: /^Date:/ }));
  const selectedDate = new Date(2026, 9, 3, 12);
  act(() =>
    open.mock.calls[2]![0].onValueChange?.(
      { nativeEvent: { timestamp: selectedDate.getTime(), utcOffset: 0 } },
      selectedDate,
    ),
  );
  expect(p.onDateChange).toHaveBeenCalledWith("2026-10-03");
});

test.each(["disabled", "unmounted"])(
  "an open Android picker is dismissed and cannot update a %s editor",
  (reason) => {
    const open = jest
      .spyOn(DateTimePickerAndroid, "open")
      .mockImplementation(() => {});
    const dismiss = jest
      .spyOn(DateTimePickerAndroid, "dismiss")
      .mockResolvedValue(false);
    const p = props();
    const { rerender, unmount } = render(<DateTimeFields {...p} />);
    fireEvent.press(screen.getByRole("button", { name: /^Date:/ }));
    const picker: AndroidNativeProps = open.mock.calls[0]![0];
    if (reason === "disabled") rerender(<DateTimeFields {...p} disabled />);
    else unmount();
    expect(dismiss).toHaveBeenCalledWith("date");
    const selected = new Date();
    act(() =>
      picker.onValueChange?.(
        { nativeEvent: { timestamp: selected.getTime(), utcOffset: 0 } },
        selected,
      ),
    );
    expect(p.onDateChange).not.toHaveBeenCalled();
  },
);
