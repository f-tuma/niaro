import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { ConnectionFailureNotice } from "../packages/ui-catalog/ConnectionFailureNotice";
import { translate } from "../packages/i18n";
test.each(["en", "cs"] as const)(
  "%s shows the actual connection phase and version mismatch",
  (language) => {
    render(
      <ConnectionFailureNotice
        language={language}
        diagnostic={{
          phase: "snapshot",
          reason: "protocol",
          httpStatus: 200,
          expectedProfile: "agent-client/0.8-fixture",
          receivedProfile: "agent-client/0.6-fixture",
          fields: ["profile"],
        }}
      />,
    );
    const tr = translate(language);
    expect(screen.getByText(tr("connectionProtocolMismatch"))).toBeTruthy();
    expect(screen.queryByText(/agent-client\/0.8-fixture/)).toBeNull();
    fireEvent.press(
      screen.getByRole("button", { name: tr("technicalDetails") }),
    );
    expect(
      screen.getByText(new RegExp(tr("connectionStageSnapshot"))),
    ).toBeTruthy();
    expect(screen.getByText(/agent-client\/0.8-fixture/)).toBeTruthy();
    expect(screen.getByText(/agent-client\/0.6-fixture/)).toBeTruthy();
  },
);
