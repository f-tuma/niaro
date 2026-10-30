import React from "react";
import * as Native from "react-native";
import { fireEvent, render, within } from "@testing-library/react-native";
import {
  MeetingDetailView,
  MeetingRow,
  MeetingProgress,
  TranscriptReader,
  meetingDuration,
  transcriptParagraphs,
  cleanTranscriptForReading,
} from "../packages/ui-catalog/MeetingView";
import {
  meetingFixture,
  meetingSegmentFixture,
  meetingRecordFixture,
} from "../packages/test-fixtures/meeting";
import { en, cs } from "../packages/i18n";
test.each(["en", "cs"] as const)(
  "meeting detail has separate transcript, points and proposal source in %s",
  (language) => {
    const tr = language === "en" ? en : cs;
    const source = jest.fn();
    const view = render(
      <MeetingDetailView
        record={meetingRecordFixture}
        language={language}
        onSource={source}
      />,
    );
    expect(view.getByText(tr.meetingTranscript)).toBeTruthy();
    expect(view.getByText(tr.meetingWholeSummary)).toBeTruthy();
    expect(view.getByText(meetingSegmentFixture.text)).toBeTruthy();
    expect(view.getByLabelText(`${tr.meetingAssignee}: Anna`)).toBeTruthy();
    expect(source).not.toHaveBeenCalled();
    const summarySources = view.getByTestId("meeting-summary-sources");
    expect(summarySources).toBeTruthy();
    expect(
      within(summarySources).queryByText(
        /We agreed to test recording recovery/,
      ),
    ).toBeNull();
    fireEvent.press(
      within(summarySources).getByRole("button", {
        name: `${tr.meetingShowSources} · 1`,
      }),
    );
    expect(
      within(summarySources).getByText(/We agreed to test recording recovery/),
    ).toBeTruthy();
    fireEvent.press(
      within(summarySources).getByRole("button", {
        name: tr.meetingSource + " 0:00",
      }),
    );
    expect(source).toHaveBeenCalledWith(0);
    fireEvent.press(
      within(summarySources).getByRole("button", {
        name: `${tr.meetingHideSources} · 1`,
      }),
    );
    expect(
      within(summarySources).queryByText(
        /We agreed to test recording recovery/,
      ),
    ).toBeNull();
    fireEvent.press(
      within(summarySources).getByRole("button", {
        name: `${tr.meetingShowSources} · 1`,
      }),
    );
    const pointSources = view.getByTestId("meeting-point-sources-0");
    fireEvent.press(
      within(pointSources).getByRole("button", {
        name: `${tr.meetingShowSources} · 1`,
      }),
    );
    expect(
      within(pointSources).getByText(/test recording recovery before release/),
    ).toBeTruthy();
    expect(source).toHaveBeenCalledWith(0);
  },
);
test.each(["en", "cs"] as const)(
  "%s can explicitly select one meeting task to continue in a process",
  (language) => {
    const tr = language === "en" ? en : cs;
    const choose = jest.fn();
    const view = render(
      <MeetingDetailView
        record={meetingRecordFixture}
        language={language}
        onSource={() => {}}
        onSelectProcessTask={choose}
      />,
    );
    fireEvent.press(
      view.getByRole("button", { name: tr.meetingProcessSelectTask }),
    );
    expect(choose).toHaveBeenCalledWith(0);
  },
);
test("a long transcript opens in its reader instead of rendering in the record", () => {
  const read = jest.fn();
  const view = render(
    <MeetingDetailView
      record={meetingRecordFixture}
      language="en"
      onSource={() => {}}
      onTranscript={read}
    />,
  );
  fireEvent.press(view.getByRole("button", { name: en.meetingReadTranscript }));
  expect(read).toHaveBeenCalledTimes(1);
  const long = Array.from({ length: 400 }, (_, i) => `Sentence ${i}.`).join(
    " ",
  );
  const paragraphs = transcriptParagraphs(`${long}\n\nSecond block.`);
  expect(paragraphs.length).toBeGreaterThan(2);
  expect(paragraphs.every((p) => p.length <= 1400)).toBe(true);
  expect(paragraphs.join(" ").replace(/\s+/g, " ")).toBe(
    `${long} Second block.`,
  );
});
test("the reading view removes fillers and obvious stutters while preserving the original", () => {
  const original = "Ehm, já já pošlu ten ten e-mail .\r\n\r\nHm, ověřím to!";
  expect(cleanTranscriptForReading(original)).toBe(
    "já já pošlu ten e-mail.\n\nověřím to!",
  );
  expect(original).toBe(
    "Ehm, já já pošlu ten ten e-mail .\r\n\r\nHm, ověřím to!",
  );
  const view = render(
    <TranscriptReader
      record={{ ...meetingRecordFixture, transcript: original }}
      language="cs"
    />,
  );
  expect(view.getByText("já já pošlu ten e-mail.")).toBeTruthy();
  fireEvent.press(
    view.getByRole("button", { name: cs.meetingTranscriptOriginal }),
  );
  expect(view.getByText("Ehm, já já pošlu ten ten e-mail .")).toBeTruthy();
});
test("the reading view preserves punctuated corrections and meaningful repetition", () => {
  const transcript = "Ne, ne. No, no. To, to udělám.";
  expect(cleanTranscriptForReading(transcript)).toBe(transcript);
  const unpunctuated =
    "Ne ne, no no, ano ano, jo jo. Velmi velmi důležité; very very important.";
  expect(cleanTranscriptForReading(unpunctuated)).toBe(unpunctuated);
  expect(cleanTranscriptForReading("ten ten ten e-mail")).toBe("ten e-mail");
  expect(cleanTranscriptForReading("To\nto udělám.")).toBe("To\nto udělám.");
});
test("reading cleanup preserves numeric punctuation and repeated grammatical words", () => {
  const transcript =
    "Schůzka je v 12:30. Cena je 1,5. I had had that before; I know that that was wrong. To to udělám.";
  expect(cleanTranscriptForReading(transcript)).toBe(transcript);
  const negation = "I did not not approve it; I will never never agree.";
  expect(cleanTranscriptForReading(negation)).toBe(negation);
});
test("reading cleanup repairs adjacent prose punctuation without splitting tokens", () => {
  expect(cleanTranscriptForReading("Ahoj,díky!Další krok:Potvrdím.")).toBe(
    "Ahoj, díky! Další krok: Potvrdím.",
  );
  expect(cleanTranscriptForReading("Kód?x=1 zůstává.")).toBe(
    "Kód?x=1 zůstává.",
  );
  expect(cleanTranscriptForReading("Uh-oh, this broke.")).toBe(
    "Uh-oh, this broke.",
  );
});
test("failed analysis keeps transcript visible and explains partial result", () => {
  const failed = {
    ...meetingFixture,
    status: "failed" as const,
    failure: "meeting_analysis_failed",
  };
  const view = render(
    <MeetingDetailView
      record={{
        ...meetingRecordFixture,
        analysis: null,
        analyzer: null,
        recordDigest: null,
        humanTaskIds: [],
        meeting: failed,
      }}
      language="cs"
      onSource={() => {}}
    />,
  );
  expect(view.getByText(cs.meetingPartial)).toBeTruthy();
  expect(view.getByText(meetingSegmentFixture.text)).toBeTruthy();
  const open = jest.fn();
  const row = render(
    <MeetingRow meeting={failed} language="cs" onOpen={open} />,
  );
  // The list names the state; the reason is read in the record itself.
  expect(row.getByText(cs.meetingPill_failed)).toBeTruthy();
  fireEvent.press(row.getByRole("button"));
  expect(open).toHaveBeenCalledTimes(1);
});
test("ready rows stay quiet; progress shows only what the server reports", () => {
  const row = render(
    <MeetingRow meeting={meetingFixture} language="en" onOpen={() => {}} />,
  );
  expect(row.queryByText(en.meetingPill_ready)).toBeNull();
  expect(row.getByText(/1 min/)).toBeTruthy();
  const ready = render(
    <MeetingProgress meeting={meetingFixture} language="en" />,
  );
  expect(ready.queryByTestId("meeting-progress")).toBeNull();
  const transcribing = render(
    <MeetingProgress
      meeting={{
        ...meetingFixture,
        status: "transcribing",
        durationSeconds: 600,
        completedSegments: 4,
      }}
      language="en"
    />,
  );
  expect(transcribing.getByText("4 of 10 min")).toBeTruthy();
  const analyzing = render(
    <MeetingProgress
      meeting={{ ...meetingFixture, status: "analyzing" }}
      language="en"
    />,
  );
  expect(analyzing.getByText(en.meeting_status_analyzing)).toBeTruthy();
  expect(analyzing.queryByText(/%|min/)).toBeNull();
  expect(meetingDuration(4320)).toBe("1 h 12 min");
});

test.each([1, 2])(
  "meeting date is announced once at font scale %s",
  (fontScale) => {
    const dimensions = jest
      .spyOn(Native, "useWindowDimensions")
      .mockReturnValue({
        width: 320,
        height: 852,
        scale: 1,
        fontScale,
      });
    try {
      const view = render(
        <MeetingRow meeting={meetingFixture} language="cs" onOpen={() => {}} />,
      );
      const date = new Intl.DateTimeFormat("cs", {
        weekday: "short",
        day: "numeric",
        month: "short",
      }).format(new Date(meetingFixture.recordedAt));
      const label = view.getByRole("button").props.accessibilityLabel as string;
      expect(label.split(date)).toHaveLength(2);
      expect(label).toContain(meetingFixture.title);
      expect(label).toContain("1 min");
    } finally {
      dimensions.mockRestore();
    }
  },
);
