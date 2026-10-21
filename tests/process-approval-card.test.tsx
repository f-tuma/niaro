import React from "react";
import { render, fireEvent } from "@testing-library/react-native";
import {
  WorkItemSchema,
  type WorkItem,
  type Language,
} from "../packages/protocol";
import { processTaskQuestion } from "../packages/test-fixtures";
import {
  WorkItemCard,
  type WorkItemCardProps,
} from "../packages/ui-catalog/WorkItemCard";
import { translate } from "../packages/i18n";

function approvalWork(language: Language = "en"): WorkItem {
  const work = processTaskQuestion(language, false);
  const result = {
    type: "service.action",
    version: 1,
    operationId: "TEST-review",
    title: "TEST Create project",
    service: "TEST Project tracker",
    status: "awaiting_approval",
    effect: "write",
    fields: [{ label: "name", value: "TEST Website" }],
    inputJson: '{"name":"TEST Website","enabled":false,"cleared":null}',
    reviewTruncated: false,
    summary: "",
  };
  return WorkItemSchema.parse({
    ...work,
    title: "TEST Process approval",
    context: "TEST recorded work remains available",
    status: "waiting_approval",
    card: {
      id: "TEST-passive-card",
      revision: 88,
      title: "TEST passive context",
      root: ["context", "history"],
      actions: [],
      nodes: [
        {
          id: "context",
          type: "notice",
          tone: "info",
          text: "TEST recorded work remains available",
        },
        {
          id: "history",
          type: "disclosure",
          label: "TEST Recorded history",
          children: ["receipt"],
        },
        { id: "receipt", type: "text", text: "TEST Earlier read completed" },
      ],
    },
    native: {
      ...work.native,
      process: {
        ...work.native!.process,
        question: undefined,
        approval: {
          nodeId: "TEST-write-step",
          serviceId: "TEST-service",
          serviceRevision: 2,
          actionId: "TEST-create-project",
          actionRevision: 4,
          result,
        },
        receipts: [
          {
            operationId: result.operationId,
            title: result.title,
            service: result.service,
            status: result.status,
            effect: result.effect,
            summary: "",
          },
        ],
      },
    },
  });
}

function props(language: Language = "en"): WorkItemCardProps {
  return {
    work: approvalWork(language),
    source: "https://TEST-server.example.test",
    workspace: "TEST-workspace",
    language,
    onAnswer: jest.fn(),
    onNativeDecision: jest.fn(),
    onProcessDecision: jest.fn(),
  };
}

test.each(["en", "cs"] as const)(
  "%s process review is passive and decisions use only its own callback and native revision",
  (language) => {
    const p = props(language);
    const fetch = jest.spyOn(globalThis, "fetch");
    const ui = render(<WorkItemCard {...p} />);
    const tr = translate(language);
    expect(
      ui.getByLabelText(`${tr("processApprovalNativeRevision")}: 7`),
    ).toBeTruthy();
    expect(
      ui.queryByLabelText(`${tr("processApprovalNativeRevision")}: 99`),
    ).toBeNull();
    expect(
      ui.queryByLabelText(`${tr("processApprovalNativeRevision")}: 88`),
    ).toBeNull();
    expect(ui.getByTestId("service-action-parameters").props.children).toBe(
      p.work.native!.process!.approval!.result.inputJson,
    );
    expect(p.onProcessDecision).not.toHaveBeenCalled();
    expect(p.onNativeDecision).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.press(ui.getByRole("button", { name: "TEST Recorded history" }));
    expect(ui.getByText("TEST Earlier read completed")).toBeTruthy();
    expect(p.onProcessDecision).not.toHaveBeenCalled();
    fireEvent.press(ui.getByRole("button", { name: tr("serviceApprove") }));
    fireEvent.press(ui.getByRole("button", { name: tr("serviceReject") }));
    expect(p.onProcessDecision).toHaveBeenNthCalledWith(1, true);
    expect(p.onProcessDecision).toHaveBeenNthCalledWith(2, false);
    expect(p.onNativeDecision).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  },
);

test.each([
  { stale: true },
  { blocked: true },
  { approvalState: "sending" as const },
  { approvalState: "accepted" as const },
  { source: "" },
  { workspace: undefined },
  { onProcessDecision: undefined },
])("process decision is blocked by passive state %j", (state) => {
  const p = props();
  const ui = render(<WorkItemCard {...p} {...state} />);
  for (const name of [
    translate("en")("serviceApprove"),
    translate("en")("serviceReject"),
  ]) {
    const button = ui.getByRole("button", { name });
    expect(button.props.accessibilityState.disabled).toBe(true);
    fireEvent.press(button);
  }
  expect(p.onProcessDecision).not.toHaveBeenCalled();
  expect(p.onNativeDecision).not.toHaveBeenCalled();
});

test("outer work state must also be exactly waiting for approval", () => {
  const p = props();
  const ui = render(
    <WorkItemCard {...p} work={{ ...p.work, status: "waiting_system" }} />,
  );
  expect(
    ui.getByText(translate("en")("processApprovalUnavailable")),
  ).toBeTruthy();
  for (const name of [
    translate("en")("serviceApprove"),
    translate("en")("serviceReject"),
  ]) {
    const button = ui.getByRole("button", { name });
    expect(button.props.accessibilityState.disabled).toBe(true);
    fireEvent.press(button);
  }
  expect(p.onProcessDecision).not.toHaveBeenCalled();
});

test.each(["en", "cs"] as const)(
  "%s unavailable review and earlier profiles keep the work and history without decisions",
  (language) => {
    for (const reason of [
      undefined,
      "context",
      "parameters",
      "identity",
    ] as const) {
      const p = props(language);
      const work: WorkItem = {
        ...p.work,
        native: {
          ...p.work.native!,
          process: {
            ...p.work.native!.process!,
            approval: undefined,
            approvalUnavailable: reason,
          },
        },
      };
      const ui = render(<WorkItemCard {...p} work={work} />);
      expect(
        ui.getByText(translate(language)("processApprovalUnavailable")),
      ).toBeTruthy();
      expect(ui.getByText(work.context)).toBeTruthy();
      expect(
        ui.queryByRole("button", {
          name: translate(language)("serviceApprove"),
        }),
      ).toBeNull();
      expect(
        ui.queryByRole("button", {
          name: translate(language)("serviceReject"),
        }),
      ).toBeNull();
      fireEvent.press(
        ui.getByRole("button", { name: "TEST Recorded history" }),
      );
      expect(ui.getByText("TEST Earlier read completed")).toBeTruthy();
      expect(p.onProcessDecision).not.toHaveBeenCalled();
      expect(p.onNativeDecision).not.toHaveBeenCalled();
      ui.unmount();
    }
  },
);
