import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import { processTaskResult } from "../packages/test-fixtures";
import { WorkItemCard } from "../packages/ui-catalog/WorkItemCard";
import { WorkItemSummary } from "../packages/ui-catalog/WorkItemSummary";
import { TaskTabs } from "../apps/mobile/ScreenChrome";
import { translate } from "../packages/i18n";
import { WorkItemSchema } from "../packages/protocol";

test.each(["en", "cs"] as const)(
  "%s passive process failure keeps its explanation and completed receipts; disclosure never approves",
  (language) => {
    const work = processTaskResult(language);
    const decision = jest.fn();
    render(
      <WorkItemCard
        work={work}
        language={language}
        compact
        onAnswer={() => {}}
        onNativeDecision={decision}
      />,
    );
    expect(screen.getAllByText(work.context)).toHaveLength(1);
    const label =
      language === "cs" ? "Uložené akce (2)" : "Recorded actions (2)";
    fireEvent.press(screen.getByRole("button", { name: label }));
    expect(
      screen.getByText(
        language === "cs" ? "Čtení · Dokončeno" : "Read · Completed",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        language === "cs"
          ? "TEST CRM · Osoba nalezena."
          : "TEST CRM · Person found.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: translate(language)("serviceApprove"),
      }),
    ).toBeNull();
    expect(decision).not.toHaveBeenCalled();
  },
);
test.each(["en", "cs"] as const)(
  "%s unknown process explains uncertainty even without negotiated cards",
  (language) => {
    const work = processTaskResult(language, "unknown");
    work.card = undefined;
    render(
      <WorkItemCard
        work={work}
        language={language}
        compact
        onAnswer={() => {}}
      />,
    );
    expect(
      screen.getByText(translate(language)("processUnknown")),
    ).toBeTruthy();
    expect(screen.getByText(work.result!)).toBeTruthy();
  },
);
test.each(["en", "cs"] as const)(
  "%s native success is not labelled as a demo and both task filters are selectable",
  (language) => {
    const onChange = jest.fn(),
      onOpen = jest.fn();
    render(
      <>
        <TaskTabs
          tab="done"
          onChange={onChange}
          count={1}
          language={language}
        />
        <WorkItemSummary
          work={processTaskResult(language, "succeeded")}
          language={language}
          onOpen={onOpen}
        />
      </>,
    );
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(
      screen.queryByRole("tab", { name: translate(language)("allTasks") }),
    ).toBeNull();
    for (const [key, tab] of [
      ["openTasks", "open"],
      ["doneTasks", "done"],
    ] as const) {
      fireEvent.press(
        screen.getByRole("tab", { name: translate(language)(key) }),
      );
      expect(onChange).toHaveBeenLastCalledWith(tab);
    }
    expect(
      screen.getAllByText(translate(language)("nativeSucceeded")),
    ).toBeTruthy();
    expect(screen.queryByText(translate(language)("succeeded"))).toBeNull();
    fireEvent.press(screen.getByTestId("summary-" + "b".repeat(64)));
    expect(onOpen).toHaveBeenCalledWith("b".repeat(64));
  },
);
test("process binding rejects ordinary native action controls and foreign conversations", () => {
  const work = processTaskResult();
  expect(
    WorkItemSchema.safeParse({ ...work, conversationId: "TEST-foreign" })
      .success,
  ).toBe(false);
  expect(
    WorkItemSchema.safeParse({
      ...work,
      native: {
        ...work.native,
        question: {
          runtime: "mastra",
          id: "TEST-question",
          revision: 1,
          workItemId: work.id,
          conversationId: work.conversationId,
          question: "TEST?",
          status: "open",
        },
      },
    }).success,
  ).toBe(false);
});
