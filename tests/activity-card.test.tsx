import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { RequestProgressCard } from "../packages/ui-catalog/RequestProgressCard";
import {
  requestActivity,
  pluginActivity,
  workflowActivity,
} from "../packages/test-fixtures";
import type { ActivityWorkflow } from "../packages/protocol/activity";
import { translate } from "../packages/i18n";

/** The steps open beneath the "Thinking" line on request. */
const expand = () => fireEvent.press(screen.getByTestId("progress-toggle"));

test.each(["en", "cs"] as const)(
  "%s progress is passive, labelled, and distinguishes each step",
  (language) => {
    render(
      <RequestProgressCard activity={requestActivity()} language={language} />,
    );
    expand();
    const tr = translate(language);
    expect(
      screen.getByLabelText(`${tr("progressCrm")}. ${tr("progressRunning")}`),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(
        `${tr("progressUnderstanding")}. ${tr("progressDone")}`,
      ),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(
        `${tr("progressPreparing")}. ${tr("progressPending")}`,
      ),
    ).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(
      screen.getAllByTestId("progress-thinking", {
        includeHiddenElements: true,
      }),
    ).toHaveLength(1);
  },
);

test.each(["en", "cs"] as const)(
  "%s pending request can be stopped before the first activity update arrives",
  (language) => {
    const tr = translate(language);
    render(
      <RequestProgressCard
        activity={null}
        language={language}
        interruptAvailable
        onInterrupt={jest.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: tr("progressInterrupt") }),
    ).toBeTruthy();
  },
);

test.each(["en", "cs"] as const)(
  "%s pending request remains stoppable when only its activity feed is unavailable",
  (language) => {
    const tr = translate(language);
    render(
      <RequestProgressCard
        activity={requestActivity()}
        connection="unavailable"
        language={language}
        interruptAvailable
        onInterrupt={jest.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: tr("progressInterrupt") }),
    ).toBeTruthy();
  },
);
test("stale progress stops animation without claiming success or failure", () => {
  const { rerender } = render(
    <RequestProgressCard
      activity={requestActivity()}
      language="cs"
      connection="unavailable"
    />,
  );
  expand();
  expect(
    screen.queryByTestId("progress-thinking", {
      includeHiddenElements: true,
    }),
  ).toBeNull();
  expect(screen.getByTestId("progress-step-crm-unknown")).toBeTruthy();
  expect(screen.getByText(/· Hotovo$/)).toBeTruthy();
  expect(screen.getByText("Výsledek není potvrzený")).toBeTruthy();
  rerender(<RequestProgressCard activity={null} language="en" interrupted />);
  expect(
    screen.queryByTestId("progress-thinking", {
      includeHiddenElements: true,
    }),
  ).toBeNull();
  expect(screen.getByText("Result not confirmed")).toBeTruthy();
});
test.each(["en", "cs"] as const)(
  "%s plugin progress distinguishes calculation, clarification and lost status",
  (language) => {
    const tr = translate(language);
    const { rerender } = render(
      <RequestProgressCard activity={pluginActivity()} language={language} />,
    );
    expand();
    expect(
      screen.getByLabelText(
        `${tr("progressDatetime")}. ${tr("progressRunning")}`,
      ),
    ).toBeTruthy();
    rerender(
      <RequestProgressCard
        activity={pluginActivity("succeeded")}
        language={language}
      />,
    );
    expect(screen.getByTestId("progress-step-datetime-succeeded")).toBeTruthy();
    rerender(
      <RequestProgressCard
        activity={pluginActivity("needs_input")}
        language={language}
      />,
    );
    expect(
      screen.getByLabelText(
        `${tr("progressDatetime")}. ${tr("progressNeedsInput")}`,
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("progress-step-datetime-succeeded")).toBeNull();
    rerender(
      <RequestProgressCard
        activity={pluginActivity()}
        language={language}
        connection="unavailable"
      />,
    );
    expect(screen.getByTestId("progress-step-datetime-unknown")).toBeTruthy();
    expect(screen.queryByTestId("progress-step-datetime-running")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  },
);
test("server-reported failure leaves future work pending", () => {
  const activity = requestActivity();
  activity.status = "failed";
  activity.steps[1]!.status = "failed";
  render(<RequestProgressCard activity={activity} language="en" />);
  expand();
  expect(screen.getByText("Request interrupted")).toBeTruthy();
  expect(screen.getByText(/· Next$/)).toBeTruthy();
  expect(
    screen.queryByTestId("progress-thinking", {
      includeHiddenElements: true,
    }),
  ).toBeNull();
});

test.each(["en", "cs"] as const)(
  "%s active request exposes an explicit interrupt action and hides it when its outcome is unknown",
  (language) => {
    const interrupt = jest.fn();
    const tr = translate(language);
    const view = render(
      <RequestProgressCard
        activity={requestActivity()}
        language={language}
        onInterrupt={interrupt}
      />,
    );
    const button = screen.getByRole("button", {
      name: tr("progressInterrupt"),
    });
    expect(interrupt).not.toHaveBeenCalled();
    fireEvent.press(button);
    expect(interrupt).toHaveBeenCalledTimes(1);
    view.rerender(
      <RequestProgressCard
        activity={requestActivity()}
        language={language}
        onInterrupt={interrupt}
        interrupted
      />,
    );
    expect(
      screen.queryByRole("button", { name: tr("progressInterrupt") }),
    ).toBeNull();
  },
);

test("a known command error shows an explicit recovery action without automatic retry", () => {
  const retry = jest.fn();
  const { rerender } = render(
    <RequestProgressCard
      activity={requestActivity()}
      language="cs"
      interrupted
      failed
      onRetry={retry}
    />,
  );
  expect(screen.getByText("Požadavek byl přerušen")).toBeTruthy();
  expect(screen.queryByText("Výsledek není potvrzený")).toBeNull();
  expect(retry).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: "Ověřit výsledek" }));
  expect(retry).toHaveBeenCalledTimes(1);
  rerender(
    <RequestProgressCard
      activity={requestActivity()}
      language="cs"
      interrupted
      failed
      onRetry={retry}
      retryDisabled
    />,
  );
  fireEvent.press(screen.getByRole("button", { name: "Ověřit výsledek" }));
  expect(retry).toHaveBeenCalledTimes(1);
});
test.each(["en", "cs"] as const)(
  "%s workflow updates one existing row and keeps tool progress separate",
  (language) => {
    const tr = translate(language);
    const { rerender } = render(
      <RequestProgressCard activity={workflowActivity()} language={language} />,
    );
    expand();
    const stages = [
      ["service", "progressService"],
      ["action", "progressAction"],
      ["inputs", "progressInputs"],
      ["execute", "progressExecute"],
    ] as const;
    for (const [stage, key] of stages) {
      const activity = workflowActivity({ step: 2, stage });
      rerender(<RequestProgressCard activity={activity} language={language} />);
      expect(
        screen.getByLabelText(`${tr(key)}. ${tr("progressRunning")}`),
      ).toBeTruthy();
      expect(screen.getAllByTestId(/^progress-step-/)).toHaveLength(2);
      expect(
        screen.queryByText(new RegExp(`^${tr("progressUnderstanding")}`)),
      ).toBeNull();
      expect(screen.getAllByRole("button")).toHaveLength(1);
    }
    rerender(
      <RequestProgressCard
        activity={{
          ...workflowActivity({ step: 5, stage: "inputs" }),
          tools: pluginActivity().tools,
        }}
        language={language}
      />,
    );
    expect(
      screen.getByLabelText(
        `${tr("progressInputs")}. ${tr("progressRunning")}`,
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("progress-step-datetime-running")).toBeTruthy();
    expect(screen.getAllByTestId(/^progress-step-/)).toHaveLength(3);
  },
);
test.each(["failed", "succeeded", "unavailable"] as const)(
  "workflow %s does not retain a running indicator",
  (state) => {
    const workflow: ActivityWorkflow = { step: 2, stage: "execute" };
    const activity = workflowActivity(workflow);
    if (state !== "unavailable") {
      activity.status = state;
      activity.steps = activity.steps.map((step) => ({
        ...step,
        status:
          state === "succeeded"
            ? "succeeded"
            : step.status === "running"
              ? "failed"
              : step.status,
      }));
    }
    render(
      <RequestProgressCard
        activity={activity}
        language="en"
        connection={state === "unavailable" ? "unavailable" : "live"}
      />,
    );
    expand();
    expect(
      screen.getByTestId(
        `progress-step-understanding-${state === "unavailable" ? "unknown" : state}`,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("progress-thinking", {
        includeHiddenElements: true,
      }),
    ).toBeNull();
  },
);
