import {
  displayFields,
  fieldLabel,
  formatFieldValue,
} from "../packages/ui-catalog/field-format";

const tz = "Europe/Prague";

test("raw parameter keys read as human labels in both languages", () => {
  expect(fieldLabel("title", "en")).toBe("Title");
  expect(fieldLabel("attendees", "cs")).toBe("Účastníci");
  expect(fieldLabel("sendInvites", "en")).toBe("Send invites");
  expect(fieldLabel("Already human", "en")).toBe("Already human");
});

test("a start/end pair becomes one local time range", () => {
  const rows = displayFields(
    [
      { label: "title", value: "TEST Call" },
      { label: "start", value: "2026-10-13T10:00:00+02:00" },
      { label: "end", value: "2026-10-13T10:30:00+02:00" },
      { label: "attendees", value: '["a@example.test","b@example.test"]' },
    ],
    "en",
    tz,
  );
  expect(rows.map((row) => row.label)).toEqual(["Title", "When", "Attendees"]);
  expect(rows[1]!.value).toMatch(/^Tue 13 Oct( 2026)? · 10:00–10:30$/);
  expect(rows[2]!.items).toEqual(["a@example.test", "b@example.test"]);
});

test("unknown values stay as written; booleans and lone instants are formatted", () => {
  expect(formatFieldValue("plain [text", "en").value).toBe("plain [text");
  expect(formatFieldValue("true", "cs").value).toBe("Ano");
  expect(formatFieldValue("2026-10-13T10:00:00+02:00", "en", tz).value).toMatch(
    /13 Oct.* · 10:00$/,
  );
  expect(formatFieldValue('[{"name":"Jana"}]', "en").items).toEqual(["Jana"]);
});
