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
