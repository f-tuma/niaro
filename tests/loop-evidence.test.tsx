import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LoopEvidenceBadges } from "../apps/server-admin/web/loop-evidence";
import { loopsCopy } from "../apps/server-admin/web/loops-copy";

test.each(["en", "cs"] as const)(
  "%s renders the unverified state and unconfirmed outcome badges",
  (language) => {
    const markup = renderToStaticMarkup(
      <LoopEvidenceBadges
        statusEvidence="last_saved_unverified"
        unconfirmedFailure
        copy={loopsCopy[language]}
      />,
    );
    expect(markup).toContain(loopsCopy[language].runningUnverified);
    expect(markup).toContain(loopsCopy[language].unconfirmedOutcome);
    expect(markup.match(/data-slot="badge"/g)).toHaveLength(2);
  },
);

test.each(["en", "cs"] as const)(
  "%s marks a completed run that recovered from failed steps with a muted badge",
  (language) => {
    const markup = renderToStaticMarkup(
      <LoopEvidenceBadges failedSteps copy={loopsCopy[language]} />,
    );
    expect(markup).toContain(loopsCopy[language].failedSteps);
    expect(markup.match(/data-slot="badge"/g)).toHaveLength(1);
    expect(markup).not.toContain("bg-warning");
    expect(markup).not.toContain("bg-destructive");
  },
);
