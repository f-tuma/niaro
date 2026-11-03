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
  "%s NIAR-280: a request whose outcome is being checked keeps Thinking, with no unconfirmed card and no Check result",
  (language) => {
    const tr = translate(language);
    render(
      <RequestProgressCard activity={requestActivity()} language={language} />,
    );
    expect(screen.getByTestId("progress-thinking")).toBeTruthy();
    expect(screen.getByText(tr("progressThinking"))).toBeTruthy();
    expand();
    expect(screen.getByTestId("progress-step-crm-running")).toBeTruthy();
    for (const words of [
      "Result not confirmed",
      "Výsledek není potvrzený",
      "Status unavailable",
      "Stav není dostupný",
      "Check result",
      "Ověřit výsledek",
      "Unconfirmed",
      "Neověřeno",
    ])
      expect(screen.queryByText(new RegExp(words))).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(1);
  },
);
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
        failed
      />,
    );
    expect(screen.getByTestId("progress-step-datetime-failed")).toBeTruthy();
    expect(screen.queryByTestId("progress-step-datetime-running")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  },
);
test("a failed step stays in the details while the line keeps thinking", () => {
  const activity = requestActivity();
  activity.status = "failed";
  activity.steps[1]!.status = "failed";
  render(<RequestProgressCard activity={activity} language="en" />);
  expect(screen.queryByText("Request interrupted")).toBeNull();
  expect(screen.getByText("Thinking")).toBeTruthy();
  expand();
  expect(screen.getByText(/· Stopped$/)).toBeTruthy();
  expect(screen.getByText(/· Next$/)).toBeTruthy();
});
test("only the request failing changes the line", () => {
  render(
    <RequestProgressCard activity={requestActivity()} language="en" failed />,
  );
  expect(screen.getByText("Request interrupted")).toBeTruthy();
  expect(
    screen.queryByTestId("progress-thinking", {
      includeHiddenElements: true,
    }),
  ).toBeNull();
});

test.each(["en", "cs"] as const)(
  "%s active request exposes an explicit interrupt action and hides it once it failed",
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
        failed
      />,
    );
    expect(
      screen.queryByRole("button", { name: tr("progressInterrupt") }),
    ).toBeNull();
  },
);

test("a failed request shows Try again without retrying by itself", () => {
  const retry = jest.fn();
  const { rerender } = render(
    <RequestProgressCard
      activity={requestActivity()}
      language="cs"
      failed
      onRetry={retry}
    />,
  );
  expect(screen.getByText("Požadavek byl přerušen")).toBeTruthy();
  expect(
    screen.getByText("Nepodařilo se dokončit. Zkus to znovu."),
  ).toBeTruthy();
  expect(retry).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: "Zkusit znovu" }));
  expect(retry).toHaveBeenCalledTimes(1);
  rerender(
    <RequestProgressCard
      activity={requestActivity()}
      language="cs"
      failed
      onRetry={retry}
      retryDisabled
    />,
  );
  fireEvent.press(screen.getByRole("button", { name: "Zkusit znovu" }));
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
test.each(["succeeded", "failed"] as const)(
  "workflow %s does not retain a running indicator",
  (state) => {
    const workflow: ActivityWorkflow = { step: 2, stage: "execute" };
    const activity = workflowActivity(workflow);
    if (state !== "failed") {
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
        failed={state === "failed"}
      />,
    );
    expand();
    expect(
      screen.getByTestId(`progress-step-understanding-${state}`),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("progress-thinking", {
        includeHiddenElements: true,
      }),
    ).toBeNull();
  },
);
