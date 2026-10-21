import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { WorkItemCard } from "../packages/ui-catalog/WorkItemCard";
import type { NativeQuestion, WorkItem } from "../packages/protocol";

const question = (extra: Partial<NativeQuestion> = {}): NativeQuestion => ({
  runtime: "mastra",
  id: "question-1",
  revision: 1,
  workItemId: "work-1",
  conversationId: "conv-1",
  question: "Který den?",
  status: "open",
  options: ["Pondělí", "Úterý", "Středa"],
  ...extra,
});
const asking = (q: NativeQuestion): WorkItem => ({
  id: "work-1",
  conversationId: "conv-1",
  revision: 2,
  title: "Schůzka",
  context: q.question,
  status: "waiting_input",
  inputRequestIds: [],
  actionProposalIds: [],
  operationIds: [],
  demo: false,
  native: { runId: "work-1", revision: 2, question: q },
  presentation: { type: "workflow.progress", version: 1, variant: "default" },
});

test("one offered answer is sent by a tap; Other goes back to typing", () => {
  const onAnswerQuestion = jest.fn();
  const onReply = jest.fn();
  render(
    <WorkItemCard
      work={asking(question())}
      language="cs"
      onAnswer={jest.fn()}
      onReply={onReply}
      onAnswerQuestion={onAnswerQuestion}
    />,
  );
  // "Other" replaces the separate reply button.
  expect(
    screen.queryByRole("button", { name: "Odpovědět v chatu" }),
  ).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Úterý" }));
  expect(onAnswerQuestion).toHaveBeenCalledWith("Úterý");
  fireEvent.press(screen.getByRole("button", { name: "Jiné…" }));
  expect(onReply).toHaveBeenCalled();
});

test("several answers are picked first and sent together", () => {
  const onAnswerQuestion = jest.fn();
  render(
    <WorkItemCard
      work={asking(question({ multiple: true }))}
      language="cs"
      onAnswer={jest.fn()}
      onAnswerQuestion={onAnswerQuestion}
    />,
  );
  fireEvent.press(screen.getByRole("checkbox", { name: "Středa" }));
  fireEvent.press(screen.getByRole("checkbox", { name: "Pondělí" }));
  expect(onAnswerQuestion).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: "Odeslat odpověď" }));
  expect(onAnswerQuestion).toHaveBeenCalledWith("Pondělí, Středa");
});

test("without offered answers the card keeps its reply button", () => {
  render(
    <WorkItemCard
      work={asking(question({ options: undefined }))}
      language="cs"
      onAnswer={jest.fn()}
      onReply={jest.fn()}
      onAnswerQuestion={jest.fn()}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Odpovědět v chatu" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Pondělí" })).toBeNull();
});
