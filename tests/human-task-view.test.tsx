import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import {
  HumanTaskActions,
  HumanTaskCard,
  HumanTaskDetail,
} from "../packages/ui-catalog/HumanTaskView";
import { humanTaskFixture } from "../packages/test-fixtures/human-task";
import { translate } from "../packages/i18n";

const title = humanTaskFixture.title;
test.each(["en", "cs"] as const)(
  "an open item is a row that opens the task; no action sits on the row in %s",
  (language) => {
    const tr = translate(language);
    const more = jest.fn();
    const view = render(
      <HumanTaskCard
        task={humanTaskFixture}
        language={language}
        onMore={more}
      />,
    );
    expect(view.getByText(title)).toBeTruthy();
    expect(view.getByText("Friday · Product planning")).toBeTruthy();
    for (const action of [
      "humanTaskResolve",
      "humanTaskComplete",
      "humanTaskRemove",
    ] as const)
      expect(view.queryByRole("button", { name: tr(action) })).toBeNull();
    fireEvent.press(
      view.getByRole("button", { name: `${tr("humanTaskMore")}: ${title}` }),
    );
    expect(more).toHaveBeenCalledTimes(1);
  },
);
test.each(["en", "cs"] as const)(
  "the task sheet shows the details and leads to the assistant in %s",
  (language) => {
    const tr = translate(language);
    const resolve = jest.fn();
    const decide = jest.fn();
    const open = jest.fn();
    const view = render(
      <>
        <HumanTaskDetail
          task={humanTaskFixture}
          language={language}
          onOpenMeeting={open}
        />
        <HumanTaskActions
          task={humanTaskFixture}
          language={language}
          onResolve={resolve}
          onDecide={decide}
        />
      </>,
    );
    expect(view.getByText(humanTaskFixture.detail)).toBeTruthy();
    expect(
      view.getByLabelText(
        `${tr("humanTaskSource")}: Let's meet again before Friday.`,
      ),
    ).toBeTruthy();
    expect(view.getByText(tr("humanTaskDue"))).toBeTruthy();
    expect(view.getByText("Friday")).toBeTruthy();
    fireEvent.press(
      view.getByRole("button", {
        name: `${tr("humanTaskFromMeeting")}: Product planning`,
      }),
    );
    expect(open).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    fireEvent.press(view.getByRole("button", { name: tr("humanTaskResolve") }));
    expect(resolve).toHaveBeenCalledTimes(1);
    fireEvent.press(
      view.getByRole("button", { name: tr("humanTaskComplete") }),
    );
    fireEvent.press(view.getByRole("button", { name: tr("humanTaskRemove") }));
    expect(decide.mock.calls).toEqual([["complete"], ["remove"]]);
  },
);
test.each(["en", "cs"] as const)(
  "a closed item says how it ended and can only be reopened in %s",
  (language) => {
    const tr = translate(language);
    const at = "2026-10-08T12:00:00.000Z";
    const done = {
      ...humanTaskFixture,
      revision: 2,
      status: "done" as const,
      resolution: {
        by: "agent" as const,
        reason: "Meeting is on Thursday.",
        at,
      },
    };
    const decide = jest.fn();
    const view = render(
      <>
        <HumanTaskCard task={done} language={language} onMore={() => {}} />
        <HumanTaskActions
          task={done}
          language={language}
          onResolve={() => {}}
          onDecide={decide}
        />
      </>,
    );
    expect(view.getByText(tr("humanTaskDone"))).toBeTruthy();
    expect(
      view.getByText(
        `${tr("humanTaskClosedByAgent")}: Meeting is on Thursday.`,
      ),
    ).toBeTruthy();
    expect(
      view.queryByRole("button", { name: tr("humanTaskResolve") }),
    ).toBeNull();
    fireEvent.press(view.getByRole("button", { name: tr("humanTaskReopen") }));
    expect(decide).toHaveBeenCalledWith("reopen");
    view.rerender(
      <HumanTaskCard
        task={{
          ...humanTaskFixture,
          revision: 2,
          status: "removed",
          resolution: { by: "user", reason: "", at },
        }}
        language={language}
        onMore={() => {}}
      />,
    );
    expect(view.getByText(tr("humanTaskRemoved"))).toBeTruthy();
    expect(view.queryByText(tr("humanTaskClosedByAgent"))).toBeNull();
  },
);
test("an uncertain command blocks the row while the item stays readable", () => {
  const more = jest.fn();
  const view = render(
    <HumanTaskCard
      task={humanTaskFixture}
      language="en"
      disabled
      pending="complete"
      onMore={more}
    />,
  );
  fireEvent.press(view.getByRole("button", { name: `Open task: ${title}` }));
  expect(more).not.toHaveBeenCalled();
  expect(view.getByText("Saving…")).toBeTruthy();
  expect(view.getByText(title)).toBeTruthy();
});
test("a busy chat only blocks talking the item through", () => {
  const resolve = jest.fn();
  const decide = jest.fn();
  const view = render(
    <HumanTaskActions
      task={humanTaskFixture}
      language="en"
      resolveDisabled
      onResolve={resolve}
      onDecide={decide}
    />,
  );
  fireEvent.press(view.getByRole("button", { name: "Resolve with assistant" }));
  fireEvent.press(view.getByRole("button", { name: "Mark as done" }));
  expect(resolve).not.toHaveBeenCalled();
  expect(decide).toHaveBeenCalledWith("complete");
});
test("the meeting opens from the task only when the screen can navigate", () => {
  const view = render(
    <HumanTaskDetail task={humanTaskFixture} language="en" />,
  );
  expect(
    view.queryByRole("button", { name: "From meeting: Product planning" }),
  ).toBeNull();
  expect(view.getByText("Product planning")).toBeTruthy();
});
