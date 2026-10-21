import { ServicePresentationSchema } from "../packages/protocol/service-presentation";

const event = {
  title: "Project review",
  start: "2026-09-27T14:00:00+02:00",
  end: "2026-09-27T14:30:00+02:00",
};
const events = (item: unknown) => ({
  kind: "events",
  items: [item],
  hasMore: false,
});

test("event timestamps accept UTC, explicit offsets, optional end, and equal endpoints", () => {
  for (const item of [
    event,
    { ...event, start: "2026-09-27T12:00:00Z" },
    { ...event, end: undefined },
    { ...event, end: event.start },
    { ...event, end: "2026-09-27T12:00:00Z" },
  ]) {
    expect(ServicePresentationSchema.safeParse(events(item)).success).toBe(
      true,
    );
  }
});

test.each(["start", "end"] as const)(
  "%s is bounded at 40 characters, including fractional seconds",
  (key) => {
    const boundary = `2026-09-27T14:00:00.${"1".repeat(19)}Z`;
    expect(boundary).toHaveLength(40);
    const valid = { ...event, start: boundary, end: boundary };
    expect(ServicePresentationSchema.safeParse(events(valid)).success).toBe(
      true,
    );
    expect(
      ServicePresentationSchema.safeParse(
        events({
          ...valid,
          [key]: `2026-09-27T14:00:00.${"1".repeat(20)}Z`,
        }),
      ).success,
    ).toBe(false);
  },
);

test.each(["start", "end"] as const)(
  "%s rejects invalid dates and ambiguous local times",
  (key) => {
    for (const value of [
      "2026-09-27T14:00:00",
      "2026-09-27",
      "2026-02-30T14:00:00Z",
      "2026-09-27T14:00:00+24:00",
      "not a date",
      "",
    ]) {
      expect(
        ServicePresentationSchema.safeParse(events({ ...event, [key]: value }))
          .success,
      ).toBe(false);
    }
  },
);

test("event ordering compares instants across offsets", () => {
  expect(
    ServicePresentationSchema.safeParse(
      events({
        ...event,
        end: "2026-09-27T13:00:00Z",
      }),
    ).success,
  ).toBe(true);
  const reversed = ServicePresentationSchema.safeParse(
    events({
      ...event,
      start: "2026-09-27T14:00:00Z",
    }),
  );
  expect(reversed.success).toBe(false);
  if (!reversed.success) {
    expect(reversed.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["items", 0, "end"] }),
      ]),
    );
  }
});

test("event timestamps must also be supported by the runtime date parser", () => {
  const parse = jest.spyOn(Date, "parse").mockReturnValue(Number.NaN);
  try {
    expect(
      ServicePresentationSchema.safeParse(
        events({ title: event.title, start: event.start }),
      ).success,
    ).toBe(false);
  } finally {
    parse.mockRestore();
  }
});

test("event presentation rejects extra instructions and excessive list size", () => {
  for (const value of [
    { ...events(event), onPress: "open-url" },
    events({ ...event, url: "https://example.test" }),
    { ...events(event), items: Array.from({ length: 11 }, () => event) },
  ]) {
    expect(ServicePresentationSchema.safeParse(value).success).toBe(false);
  }
});
