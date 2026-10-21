import React from "react";
import {
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react-native";
import { ProcessApprovalRecoveryCard } from "../packages/ui-catalog/ProcessApprovalRecoveryCard";
import type { Language } from "../packages/protocol";
import { translate } from "../packages/i18n";
import { processApprovalWork } from "./helpers/process-approval-client";

function review() {
  const approval = processApprovalWork().native!.process!.approval!;
  return {
    title: approval.result.title,
    service: approval.result.service,
    approved: false,
    effect: "write" as const,
    frame: {
      source: "https://TEST-server.example.test/v1/TEST-workspace",
      workspace: "TEST-workspace",
      nativeRevision: 7,
      conversationId: "TEST-original-conversation",
      language: "en" as const,
      serviceId: approval.serviceId,
      serviceRevision: approval.serviceRevision,
      actionId: approval.actionId,
      actionRevision: approval.actionRevision,
    },
    result: approval.result,
  };
}

test.each(["en", "cs"] as const)(
  "%s saved review is read-only local evidence and retains complete original parameters",
  (language: Language) => {
    const original = review(),
      tr = translate(language),
      onRetry = jest.fn();
    render(
      <ProcessApprovalRecoveryCard
        language={language}
        review={original}
        outcome="unknown"
        canRetry
        onRetry={onRetry}
      />,
    );
    const card = within(screen.getByTestId("saved-process-approval"));
    expect(card.getByText(original.title)).toBeTruthy();
    expect(card.getByText(original.service)).toBeTruthy();
    expect(
      card.getByLabelText(
        `${tr("savedProcessApprovalDecision")}: ${tr("savedProcessApprovalReject")}`,
      ),
    ).toBeTruthy();
    expect(card.queryByText(tr("serviceAwaiting"))).toBeNull();
    expect(
      card.queryByRole("button", { name: tr("serviceApprove") }),
    ).toBeNull();
    expect(
      card.queryByRole("button", { name: tr("serviceReject") }),
    ).toBeNull();
    expect(card.queryByText(tr("serviceWriteEffect"))).toBeNull();
    expect(card.getByText(tr("savedProcessApprovalEffectWrite"))).toBeTruthy();
    fireEvent.press(
      card.getByRole("button", { name: tr("savedProcessApprovalReview") }),
    );
    expect(onRetry).not.toHaveBeenCalled();
    expect(card.getByTestId("service-action-parameters").props.children).toBe(
      original.result.inputJson,
    );
    expect(
      card.getByLabelText(`${tr("processApprovalNativeRevision")}: 7`),
    ).toBeTruthy();
    expect(
      card.getByLabelText(
        `${tr("processesConversation")}: TEST-original-conversation`,
      ),
    ).toBeTruthy();
    expect(
      card.getByLabelText(`${tr("language")}: ${tr("english")}`),
    ).toBeTruthy();
    fireEvent.press(
      card.getByRole("button", { name: tr("savedProcessApprovalRetrySame") }),
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
  },
);

test.each(["accepted", "rejected"] as const)(
  "known %s review describes local saving without a business result",
  (outcome) => {
    const tr = translate("en");
    render(
      <ProcessApprovalRecoveryCard
        language="en"
        review={review()}
        outcome={outcome}
        explanation="TEST Original rejection reason"
        canRetry
        onRetry={jest.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: tr("processesRetrySaving") }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", {
        name: tr("savedProcessApprovalRetrySame"),
      }),
    ).toBeNull();
    expect(
      screen.getByText(
        tr(
          outcome === "accepted"
            ? "savedProcessApprovalAccepted"
            : "savedProcessApprovalRejected",
        ),
      ),
    ).toBeTruthy();
    expect(screen.getByText("TEST Original rejection reason")).toBeTruthy();
    expect(screen.queryByText(tr("serviceSucceeded"))).toBeNull();
  },
);

test("legacy saved receipt shows missing parameters without creating a replacement review", () => {
  const original = review();
  render(
    <ProcessApprovalRecoveryCard
      language="en"
      review={{ ...original, result: undefined }}
      outcome="unknown"
      canRetry
      onRetry={jest.fn()}
    />,
  );
  fireEvent.press(
    screen.getByRole("button", {
      name: translate("en")("savedProcessApprovalReview"),
    }),
  );
  expect(
    screen.getByText(
      translate("en")("savedProcessApprovalParametersUnavailable"),
    ),
  ).toBeTruthy();
  expect(screen.queryByTestId("service-action-parameters")).toBeNull();
});

test.each(["proof", "blocked", "retrying"])(
  "%s prevents even a retained pure-view retry",
  (mode) => {
    const onRetry = jest.fn();
    const props = {
      language: "en" as const,
      review: mode === "proof" ? undefined : review(),
      outcome: "unknown" as const,
      canRetry: mode !== "blocked",
      retrying: mode === "retrying",
      onRetry,
    };
    render(<ProcessApprovalRecoveryCard {...props} />);
    const button = screen.getByRole("button", {
      name: translate("en")(
        mode === "retrying"
          ? "savedProcessApprovalRetrying"
          : "savedProcessApprovalRetrySame",
      ),
    });
    expect(button).toBeDisabled();
    fireEvent.press(button);
    expect(onRetry).not.toHaveBeenCalled();
  },
);
