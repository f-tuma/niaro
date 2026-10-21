import {
  displayFieldIcon,
  displayLink,
} from "../packages/protocol/display-link";

test.each([
  ["+420 555 010 001", "phone", "tel:+420555010001"],
  ["(555) 010-001", "phone", "tel:555010001"],
  ["555 010-001", "phone", "tel:555010001"],
  ["test.person@example.test", "email", "mailto:test.person@example.test"],
  [
    "person+review@example.test",
    "email",
    "mailto:person%2Breview@example.test",
  ],
  [
    "https://example.test/review?item=1#details",
    "url",
    "https://example.test/review?item=1#details",
  ],
  ["http://192.168.1.20:8081/status", "url", "http://192.168.1.20:8081/status"],
] as const)(
  "a complete %s value yields only its safe visible destination",
  (value, kind, href) => {
    expect(displayLink(value, kind)?.href).toBe(href);
  },
);

test.each([
  "javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "file:///etc/passwd",
  "intent://call/#Intent;end",
  "tel:+420555010001",
  "mailto:person@example.test?subject=Hidden",
  "//example.test/path",
  "https://person:password@example.test",
  "https://example.test\\@other.test/",
  "https://example.test/\n",
  "https://exam\u200bple.test/",
  "https://example.test/has space",
  "person@example.test?bcc=other@example.test",
  "person@example.test\r\nBcc: other@example.test",
  "person@example.test,other@example.test",
  "Read https://example.test first",
  "555010001",
  "Record 555010001",
  "+420 555 010 001",
  "",
])("ambiguous, numeric or unsupported %s values remain plain text", (value) => {
  expect(displayLink(value)).toBeUndefined();
});

test.each([
  "+420 555 010 001, +420 555 010 002",
  "+420 555 010 001 ext. 42",
  "Call +420 555 010 001",
  "*123#",
  "+420555010001;123",
  "+420555010001?x=1",
  "420+555010001",
  "1234567890123456",
  "person@example.test",
  "https://example.test",
  "tel:+420555010001",
  "123\n456",
  "12",
])(
  "an explicitly typed phone field rejects %s command or non-number data",
  (value) => {
    expect(displayLink(value, "phone")).toBeUndefined();
  },
);

test("only known phone labels add phone semantics; URLs and emails are complete values", () => {
  for (const label of [
    "Phone",
    "Phone number",
    "mobile_number",
    "Telefonní číslo",
  ])
    expect(displayFieldIcon(label, "+420 555 010 001")).toBe("phone");
  for (const label of ["Record ID", "Quantity", "Cost", "Phone ID", "Owner"])
    expect(displayFieldIcon(label, "555010001")).toBeUndefined();
  expect(displayFieldIcon("Email", "not an email")).toBeUndefined();
  expect(displayFieldIcon("Phone", "number not recorded")).toBeUndefined();
  expect(displayFieldIcon("Meeting", "https://example.test/review")).toBe(
    "link",
  );
  expect(displayFieldIcon("Organizer", "person@example.test")).toBe("mail");
});
