/** UI suites exercise the controller through pure ports; native capture needs device acceptance. */
jest.mock("../apps/mobile/meeting-device", () => ({
  useMeetingDevice: () => ({ capture: null, durationMillis: 0 }),
}));
