import { translate } from "../packages/i18n";

test("human task waiting filter uses concise waiting labels", () => {
  expect(translate("en")("openTasks")).toBe("Waiting");
  expect(translate("cs")("openTasks")).toBe("Čeká");
});
