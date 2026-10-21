import React from "react";
import {
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react-native";
import { processLaunchDetails } from "./helpers/process-launch-details";
import { translate } from "../packages/i18n";
import type { Language } from "../packages/protocol";
import type {
  ProcessExecutionEntry,
  ProcessInputCard,
} from "../packages/protocol/process-execution";
import {
  ProcessLaunchView,
  type ProcessLaunchViewProps,
} from "../packages/ui-catalog/ProcessLaunchView";
import { processInputCopy as copy } from "../packages/ui-catalog/process-input-copy";
import { meetingRecordFixture } from "../packages/test-fixtures/meeting";

const schema = {
  type: "object" as const,
  properties: {
    title: { type: "string" as const },
    count: { type: "integer" as const },
    enabled: { type: "boolean" as const },
    cleared: { type: "null" as const },
    rows: { type: "array" as const, items: { type: "string" as const } },
    omitted: { type: "string" as const },
  },
  required: ["title", "count", "enabled", "cleared", "rows"],
  additionalProperties: false as const,
};
const ready: ProcessExecutionEntry = {
  processId: "test-process",
  name: "TEST original process",
  description: "TEST original purpose",
  kind: "workflow",
  version: 4,
  artifactDigest: "a".repeat(64),
  availability: "ready",
  inputSchema: schema,
};
const blocked: ProcessExecutionEntry = {
  processId: "test-blocked-process",
  name: "TEST blocked process",
  description: "TEST unavailable purpose",
  kind: "agent",
  version: 2,
  artifactDigest: "b".repeat(64),
  availability: "blocked",
  reason: "qualification_required",
};
function fixture(language: Language = "en"): ProcessInputCard {
  const origin = {
    type: "command" as const,
    conversationId: "test-original-conversation",
    requestId: "test-request",
  };
  const formDigest = "c".repeat(64);
  return {
    form: {
      profile: "agent-process-input/1",
      scope: {
        connectionId: "test-connection",
        serverId: "test-server",
        userId: "test-user",
        workspaceId: "test-workspace",
      },
      language,
      processId: ready.processId,
      name: ready.name,
      description: ready.description,
      version: ready.version,
      kind: ready.kind,
      artifactDigest: ready.artifactDigest,
      inputSchema: schema,
      origin,
    },
    formDigest,
    intent: {
      intentId: "test-intent",
      processId: ready.processId,
      version: ready.version,
      artifactDigest: ready.artifactDigest,
      formDigest,
      inputSchema: schema,
      fields: {},
      origin,
      createdAt: "2026-10-06T10:00:00.000Z",
    },
  };
}
function props(
  overrides: Partial<ProcessLaunchViewProps> = {},
): ProcessLaunchViewProps {
  return {
    language: "en",
    entries: [ready, blocked],
    selected: null,
    loading: false,
    phase: "selection",
    card: null,
    reviewedInput: null,
    disabled: false,
    onLoad: jest.fn(),
    onSelect: jest.fn(),
    onPrepare: jest.fn(),
    onReview: jest.fn(),
    onEdit: jest.fn(),
    onStart: jest.fn(),
    ...overrides,
  };
}
const exactInput = {
  title: " \t ",
  count: 0,
  enabled: false,
  cleared: null,
  rows: ["", "  second  ", "first"],
};
function enterDraft(language: Language = "en") {
  fireEvent.changeText(screen.getByLabelText("title"), exactInput.title);
  fireEvent.changeText(screen.getByLabelText("count"), "0");
  fireEvent.press(
    screen.getByRole("radio", { name: `enabled: ${copy(language, "no")}` }),
  );
  for (const [index, value] of exactInput.rows.entries()) {
    fireEvent.press(
      screen.getByRole("button", {
        name: copy(language, "add", { field: "rows" }),
      }),
    );
    fireEvent.changeText(
      screen.getByLabelText(
        `rows › ${copy(language, "item", { number: index + 1 })}`,
      ),
      value,
    );
  }
}

test.each(["en", "cs"] as const)(
  "%s review shows exact typed values and explicit actions while the original draft stays mounted",
  (language) => {
    const tr = translate(language);
    const current = props({
      language,
      phase: "editing",
      selected: ready,
      card: fixture(language),
    });
    const view = render(<ProcessLaunchView {...current} />);
    enterDraft(language);
    const editor = screen.getByTestId("process-launch-editor");
    fireEvent.press(
      screen.getByRole("button", { name: copy(language, "prepare") }),
    );
    expect(current.onReview).toHaveBeenCalledTimes(1);
    expect(current.onReview).toHaveBeenCalledWith(exactInput);
    expect(current.onStart).not.toHaveBeenCalled();

    const reviewed = {
      ...current,
      phase: "review" as const,
      reviewedInput: exactInput,
    };
    view.rerender(<ProcessLaunchView {...reviewed} />);
    expect(screen.queryByLabelText("title")).toBeNull();
    const hiddenEditor = screen.getByTestId("process-launch-editor", {
      includeHiddenElements: true,
    });
    expect(hiddenEditor).toBe(editor);
    expect(hiddenEditor.props.importantForAccessibility).toBe(
      "no-hide-descendants",
    );
    expect(hiddenEditor.props.accessibilityElementsHidden).toBe(true);
    const json = processLaunchDetails();
    expect(json.props.children).toBe(JSON.stringify(exactInput, null, 2));
    expect(json.props.selectable).toBe(true);
    expect(json.props.numberOfLines).toBeUndefined();
    expect(screen.getByText(ready.name)).toBeTruthy();
    expect(
      screen.getByText(
        `${tr("processesVersion")}: 4 · ${tr("processesWorkflow")}`,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        `${tr("processesConversation")}: test-original-conversation`,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        `${tr("language")}: ${tr(language === "cs" ? "czech" : "english")}`,
      ),
    ).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: tr("processesEdit") }));
    expect(current.onEdit).toHaveBeenCalledTimes(1);
    expect(current.onStart).not.toHaveBeenCalled();

    for (const phase of ["sending", "accepted", "rejected"] as const) {
      view.rerender(<ProcessLaunchView {...reviewed} phase={phase} disabled />);
      expect(
        screen.getByTestId("process-launch-editor", {
          includeHiddenElements: true,
        }),
      ).toBe(editor);
      expect(processLaunchDetails().props.children).toBe(
        JSON.stringify(exactInput, null, 2),
      );
      expect(
        screen.queryByRole("button", { name: tr("processesStart") }),
      ).toBeNull();
    }
    view.rerender(<ProcessLaunchView {...current} />);
    expect(screen.getByLabelText("title").props.value).toBe(exactInput.title);
    expect(screen.getByLabelText("count").props.value).toBe("0");
    expect(
      screen.getByRole("radio", { name: `enabled: ${copy(language, "no")}` })
        .props.accessibilityState.checked,
    ).toBe(true);
    expect(
      screen.getByLabelText(`rows › ${copy(language, "item", { number: 2 })}`)
        .props.value,
    ).toBe("  second  ");
    fireEvent.press(
      screen.getByRole("button", { name: copy(language, "prepare") }),
    );
    expect(current.onReview).toHaveBeenLastCalledWith(exactInput);
  },
);

test.each(["en", "cs"] as const)(
  "%s blocked entries show a safe reason and cannot select or prepare",
  (language) => {
    const tr = translate(language);
    const current = props({ language });
    const view = render(<ProcessLaunchView {...current} />);
    const unavailable = screen.getByRole("radio", {
      name: `${tr("processesSelect")}: ${blocked.name}`,
    });
    expect(unavailable.props.accessibilityState.disabled).toBe(true);
    expect(
      screen.getByText(
        `${tr("processesBlocked")}: ${tr("process_qualification_required")}`,
      ),
    ).toBeTruthy();
    expect(screen.getByText(blocked.description)).toBeTruthy();
    fireEvent.press(unavailable);
    expect(current.onSelect).not.toHaveBeenCalled();
    fireEvent.press(
      screen.getByRole("radio", {
        name: `${tr("processesSelect")}: ${ready.name}`,
      }),
    );
    expect(current.onSelect).toHaveBeenCalledWith(ready);
    view.rerender(<ProcessLaunchView {...current} selected={blocked} />);
    fireEvent.press(
      screen.getByRole("button", { name: tr("processesPrepare") }),
    );
    expect(current.onPrepare).not.toHaveBeenCalled();
  },
);

test.each(["en", "cs"] as const)(
  "%s meeting launch requires explicit compatible field mapping",
  (language) => {
    const tr = translate(language);
    const onSourceBinding = jest.fn();
    const view = render(
      <ProcessLaunchView
        {...props({
          language,
          selected: ready,
          meetingRecord: meetingRecordFixture,
          onSourceBinding,
        })}
      />,
    );
    expect(view.getByText(tr("meetingProcessMapTitle"))).toBeTruthy();
    expect(view.getByTestId("meeting-source-map-title")).toBeTruthy();
    expect(view.getByTestId("meeting-source-map-rows")).toBeTruthy();
    expect(view.queryByTestId("meeting-source-map-count")).toBeNull();
    fireEvent.press(
      within(view.getByTestId("meeting-source-map-title")).getByRole("button", {
        name: tr("meetingProcessSourceSummary"),
      }),
    );
    expect(onSourceBinding).toHaveBeenCalledWith("title", "summary");
  },
);

test.each(["en", "cs"] as const)(
  "%s maps only the explicitly selected meeting task with its exact source references",
  (language) => {
    const tr = translate(language);
    const onSourceBinding = jest.fn();
    const selected = {
      ...ready,
      inputSchema: {
        type: "object" as const,
        properties: {
          proposal: {
            type: "object" as const,
            properties: {
              text: { type: "string" as const },
              assignee: { type: "string" as const },
              due: { type: "string" as const },
              sources: {
                type: "array" as const,
                items: {
                  type: "object" as const,
                  properties: {
                    segment: { type: "integer" as const },
                    quote: { type: "string" as const },
                  },
                  required: ["segment", "quote"],
                  additionalProperties: false as const,
                },
              },
            },
            required: ["text", "sources"],
            additionalProperties: false as const,
          },
        },
        required: ["proposal"],
        additionalProperties: false as const,
      },
    };
    const view = render(
      <ProcessLaunchView
        {...props({
          language,
          selected,
          selectedTaskId: meetingRecordFixture.humanTaskIds[0],
          meetingRecord: meetingRecordFixture,
          onSourceBinding,
        })}
      />,
    );
    const proposal = view.getByTestId("meeting-source-map-proposal");
    fireEvent.press(
      within(proposal).getByRole("button", {
        name: tr("meetingProcessSourceSelectedTask"),
      }),
    );
    expect(onSourceBinding).toHaveBeenCalledWith("proposal", "selectedTask");
  },
);

test("long meeting transcript is never shortened and can map into an explicitly larger input", () => {
  const longRecord = {
    ...meetingRecordFixture,
    transcript: "full sentence ".repeat(400),
  };
  const largeTextSchema = {
    type: "object" as const,
    properties: {
      transcript: { type: "string" as const, maxLength: 60_000 },
    },
    required: ["transcript"],
    additionalProperties: false as const,
  };
  const selected = { ...ready, inputSchema: largeTextSchema };
  const tr = translate("en");
  const onSourceBinding = jest.fn();
  const view = render(
    <ProcessLaunchView
      {...props({
        selected,
        meetingRecord: longRecord,
        onSourceBinding,
      })}
    />,
  );
  expect(
    screen.queryByText(tr("meetingProcessTranscriptLimitHint")),
  ).toBeNull();
  expect(
    screen.queryByText(
      `${tr("meetingProcessTranscriptLength")} ${longRecord.transcript.length}`,
    ),
  ).toBeNull();
  fireEvent.press(
    within(view.getByTestId("meeting-source-map-transcript")).getByRole(
      "button",
      { name: tr("meetingProcessSourceTranscript") },
    ),
  );
  expect(onSourceBinding).toHaveBeenCalledWith("transcript", "transcript");
  view.rerender(
    <ProcessLaunchView
      {...props({
        selected,
        meetingRecord: {
          ...longRecord,
          transcript: "x".repeat(60_001),
        },
      })}
    />,
  );
  expect(
    screen.getByText(tr("meetingProcessTranscriptLimitHint")),
  ).toBeTruthy();
  expect(
    screen.getByText(`${tr("meetingProcessTranscriptLength")} 60001`),
  ).toBeTruthy();
  expect(
    within(screen.getByTestId("meeting-source-map-transcript")).queryByRole(
      "button",
      { name: tr("meetingProcessSourceTranscript") },
    ),
  ).toBeNull();
});

test("empty and multiple inventories remain passive and include the final loaded entry", () => {
  const current = props({ entries: [] });
  const tr = translate("en");
  const view = render(<ProcessLaunchView {...current} />);
  expect(screen.getByText(tr("processesEmpty"))).toBeTruthy();
  expect(screen.queryByRole("radio")).toBeNull();
  const entries = Array.from({ length: 110 }, (_, index) => ({
    ...ready,
    processId: `test-process-${index}`,
    name: `TEST process ${index}`,
  }));
  view.rerender(<ProcessLaunchView {...current} entries={entries} />);
  fireEvent.press(
    screen.getByRole("radio", {
      name: `${tr("processesSelect")}: TEST process 109`,
    }),
  );
  expect(current.onSelect).toHaveBeenCalledWith(entries[109]);
  expect(current.onLoad).not.toHaveBeenCalled();
  expect(current.onPrepare).not.toHaveBeenCalled();
});

test("disabled review cannot edit or start; enabled Start requires an explicit press", () => {
  const tr = translate("en");
  const current = props({
    phase: "review",
    card: fixture(),
    reviewedInput: exactInput,
    disabled: true,
  });
  const view = render(<ProcessLaunchView {...current} />);
  for (const key of ["processesEdit", "processesStart"] as const) {
    const button = screen.getByRole("button", { name: tr(key) });
    expect(button.props.accessibilityState.disabled).toBe(true);
    fireEvent.press(button);
  }
  expect(current.onEdit).not.toHaveBeenCalled();
  expect(current.onStart).not.toHaveBeenCalled();
  view.rerender(<ProcessLaunchView {...current} disabled={false} />);
  expect(current.onStart).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: tr("processesStart") }));
  expect(current.onStart).toHaveBeenCalledTimes(1);
});

test("selecting another ready entry while preparing is explicit and keeps load and prepare disabled", () => {
  const tr = translate("en");
  const other: ProcessExecutionEntry = {
    ...ready,
    processId: "test-other-process",
    name: "TEST other process",
  };
  const current = props({
    phase: "preparing",
    selected: ready,
    entries: [ready, other, blocked],
  });
  render(<ProcessLaunchView {...current} />);
  fireEvent.press(
    screen.getByRole("radio", {
      name: `${tr("processesSelect")}: ${other.name}`,
    }),
  );
  expect(current.onSelect).toHaveBeenCalledWith(other);
  fireEvent.press(screen.getByRole("button", { name: tr("refresh") }));
  fireEvent.press(
    screen.getByRole("button", { name: tr("processesPreparing") }),
  );
  expect(current.onLoad).not.toHaveBeenCalled();
  expect(current.onPrepare).not.toHaveBeenCalled();
});

test("rejected inputs can explicitly return to editing and require another review before Start", () => {
  const tr = translate("en");
  const current = props({
    phase: "rejected",
    card: fixture(),
    reviewedInput: exactInput,
  });
  const view = render(<ProcessLaunchView {...current} />);
  expect(
    screen.queryByRole("button", { name: tr("processesStart") }),
  ).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: tr("processesEdit") }));
  expect(current.onEdit).toHaveBeenCalledTimes(1);
  expect(current.onStart).not.toHaveBeenCalled();
  view.rerender(<ProcessLaunchView {...current} disabled />);
  fireEvent.press(screen.getByRole("button", { name: tr("processesEdit") }));
  expect(current.onEdit).toHaveBeenCalledTimes(1);
});

test("a restored reviewed card seeds its first editor mount from the original typed input", () => {
  const current = props({
    phase: "rejected",
    card: fixture(),
    reviewedInput: exactInput,
  });
  const view = render(<ProcessLaunchView {...current} />);
  expect(current.onReview).not.toHaveBeenCalled();
  view.rerender(
    <ProcessLaunchView {...current} phase="editing" reviewedInput={null} />,
  );
  expect(screen.getByLabelText("title").props.value).toBe(exactInput.title);
  expect(screen.getByLabelText("count").props.value).toBe("0");
  expect(
    screen.getByRole("radio", { name: "enabled: False" }).props
      .accessibilityState.checked,
  ).toBe(true);
  expect(screen.getByLabelText("rows › Item 1").props.value).toBe("");
  expect(screen.getByLabelText("rows › Item 2").props.value).toBe("  second  ");
  expect(screen.getByLabelText("rows › Item 3").props.value).toBe("first");
  expect(screen.queryByLabelText("omitted")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: copy("en", "prepare") }));
  expect(current.onReview).toHaveBeenCalledWith(exactInput);
});

test.each(["review", "accepted", "rejected"] as const)(
  "%s permits an explicit return to selection while disabled and sending states prevent it",
  (phase) => {
    const tr = translate("en");
    const current = props({
      phase,
      card: fixture(),
      reviewedInput: exactInput,
    });
    const view = render(<ProcessLaunchView {...current} />);
    const label = tr("processesChooseAnother");
    fireEvent.press(screen.getByRole("button", { name: label }));
    expect(current.onLoad).toHaveBeenCalledTimes(1);
    view.rerender(<ProcessLaunchView {...current} disabled />);
    fireEvent.press(screen.getByRole("button", { name: label }));
    expect(current.onLoad).toHaveBeenCalledTimes(1);
    view.rerender(<ProcessLaunchView {...current} phase="sending" />);
    expect(screen.queryByRole("button", { name: label })).toBeNull();
  },
);

test.each(["unknown", "accepted", "rejected"] as const)(
  "%s recovery keeps original context and JSON and exposes the corresponding retry callback",
  (outcome) => {
    const tr = translate("cs");
    const retry = jest.fn();
    const recovery: NonNullable<ProcessLaunchViewProps["recovery"]> = {
      name: "TEST saved original process",
      version: 8,
      kind: "agent",
      conversationId: "test-saved-conversation",
      language: "en",
      input: exactInput,
      outcome,
      sending: false,
      error: null,
      canRetry: true,
      onRetry: retry,
    };
    const current = props({
      language: "cs",
      phase: "sending",
      card: fixture("cs"),
      reviewedInput: { title: "TEST unrelated draft" },
      disabled: true,
      recovery,
    });
    const view = render(<ProcessLaunchView {...current} />);
    expect(screen.getByText(recovery.name)).toBeTruthy();
    const json = processLaunchDetails("process-launch-recovery-input");
    expect(
      screen.getByText(
        `${tr("processesVersion")}: 8 · ${tr("processesAgent")}`,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        `${tr("processesConversation")}: test-saved-conversation`,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(`${tr("language")}: ${tr("english")}`),
    ).toBeTruthy();
    expect(json.props.children).toBe(JSON.stringify(exactInput, null, 2));
    expect(json.props.selectable).toBe(true);
    expect(json.props.numberOfLines).toBeUndefined();
    expect(screen.queryByTestId("process-launch-review")).toBeNull();
    expect(screen.queryByText(tr("processesSending"))).toBeNull();
    expect(screen.queryByText(tr("processesSavingPending")) !== null).toBe(
      outcome !== "unknown",
    );
    expect(retry).not.toHaveBeenCalled();
    const label = tr(
      outcome === "unknown" ? "processesRetrySame" : "processesRetrySaving",
    );
    fireEvent.press(screen.getByRole("button", { name: label }));
    expect(retry).toHaveBeenCalledTimes(1);
    if (outcome !== "unknown") {
      view.rerender(
        <ProcessLaunchView
          {...current}
          recovery={{ ...recovery, error: "processesSavingFailed" }}
        />,
      );
      expect(screen.getByText(tr("processesSavingFailed"))).toBeTruthy();
      expect(screen.queryByText(tr("processesSavingPending"))).toBeNull();
    }
    view.rerender(
      <ProcessLaunchView
        {...current}
        recovery={{ ...recovery, canRetry: false }}
      />,
    );
    fireEvent.press(screen.getByRole("button", { name: label }));
    expect(retry).toHaveBeenCalledTimes(1);
    view.rerender(
      <ProcessLaunchView
        {...current}
        recovery={{ ...recovery, sending: true }}
      />,
    );
    const sending = screen.getByRole("button", {
      name: tr("processesSending"),
    });
    expect(screen.queryByText(tr("processesSavingPending"))).toBeNull();
    expect(sending.props.accessibilityState.busy).toBe(true);
    fireEvent.press(sending);
    expect(retry).toHaveBeenCalledTimes(1);
  },
);

test("renders and replays every phase without calling a callback or transport", () => {
  const fetch = jest.spyOn(globalThis, "fetch");
  const current = props({ card: fixture(), reviewedInput: exactInput });
  try {
    const view = render(<ProcessLaunchView {...current} />);
    for (const phase of [
      "preparing",
      "editing",
      "review",
      "sending",
      "accepted",
      "rejected",
    ] as const) {
      view.rerender(<ProcessLaunchView {...current} phase={phase} />);
    }
    for (const callback of [
      current.onLoad,
      current.onSelect,
      current.onPrepare,
      current.onReview,
      current.onEdit,
      current.onStart,
    ])
      expect(callback).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});
