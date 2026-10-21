import { modelName, readableName } from "../packages/protocol/display-name";

test("machine identifiers read as sentence-case names; prose stays as written", () => {
  expect(readableName("list-mail-messages")).toBe("List mail messages");
  expect(readableName("search_people")).toBe("Search people");
  expect(readableName("getCalendarView")).toBe("Get calendar view");
  expect(readableName("CRM_lookup")).toBe("CRM lookup");
  expect(readableName("Najdi kontakty v CRM")).toBe("Najdi kontakty v CRM");
  expect(readableName("  ")).toBe("");
});

test("model IDs drop the routing prefix and read as product names", () => {
  expect(modelName("google/gemini-3.1-flash-lite")).toBe(
    "Gemini 3.1 Flash Lite",
  );
  expect(modelName("openai/gpt-audio-mini")).toBe("GPT Audio Mini");
  expect(modelName("Whisper small")).toBe("Whisper small");
});
