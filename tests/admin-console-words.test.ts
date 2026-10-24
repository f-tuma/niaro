import { shellCopy } from "../apps/server-admin/web/shell-copy";
import { catalogCopy } from "../apps/server-admin/web/catalog-copy";
import { mcpCopy } from "../apps/server-admin/web/mcp-copy";
import {
  usageCopy,
  usageSaveStatus,
} from "../apps/server-admin/web/usage-copy";
import { navigation } from "../apps/server-admin/web/console-navigation";
import {
  countToday,
  needsAttention,
  requestShare,
  requestsWarning,
} from "../apps/server-admin/web/lib/needs-attention";
import { plural } from "../apps/server-admin/web/lib/plural";

// The console speaks to administrators who are not developers: every page is
// named for what it does, in both languages, and the same name everywhere.
describe("admin navigation", () => {
  test.each([
    ["en", "Built-in tools", "External AI apps", "Installed connectors"],
    [
      "cs",
      "Vestavěné nástroje",
      "Externí AI aplikace",
      "Instalované konektory",
    ],
  ] as const)(
    "%s names pages for what they do",
    (language, plugins, mcp, hosted) => {
      const copy = shellCopy[language];
      expect([copy.plugins, copy.mcp, copy.hosted]).toEqual([
        plugins,
        mcp,
        hosted,
      ]);
      expect(copy.audit).toBe(
        language === "en" ? "Activity log" : "Historie změn",
      );
      expect(copy.routing).toBe(
        language === "en" ? "Model choice" : "Výběr modelů",
      );
      expect(copy.loops).toBe(language === "en" ? "Runs" : "Běhy");
      expect(copy.stageDecision).toBe(
        language === "en" ? "Service picker" : "Výběr služby",
      );
      // Page titles say the same as the sidebar.
      expect(catalogCopy[language].routing).toBe(copy.routing);
      expect(catalogCopy[language].plugins).toBe(copy.plugins);
      expect(mcpCopy[language].title).toBe(copy.mcp);
    },
  );

  test("installed connectors sit with the services they serve", () => {
    const group = (key: string) =>
      navigation.find((g) => g.items.some((item) => item.key === key))?.label;
    expect(group("hosted")).toBe("groupServices");
    expect(group("services")).toBe("groupServices");
    expect(group("audit")).toBe("groupSettings");
    expect(navigation.flatMap((g) => g.items).map((i) => i.key)).toHaveLength(
      new Set(navigation.flatMap((g) => g.items).map((i) => i.key)).size,
    );
  });

  test("workspace words are in the right language", () => {
    expect(catalogCopy.en.workspaces).toBe("Workspaces");
    expect(catalogCopy.en.workspace).toBe("Workspace");
    expect(catalogCopy.cs.workspaces).toBe("Pracovní prostory");
    expect(catalogCopy.cs.workspace).toBe("Pracovní prostor");
  });

  test("actions people may use are called allowed", () => {
    expect(shellCopy.en.actionsGranted).toBe("Allowed actions");
    expect(shellCopy.cs.actionsGranted).toBe("Povolené akce");
    const fill = (text: string) =>
      text.replace("{n}", "3").replace("{total}", "12");
    expect(fill(shellCopy.en.allowedOf)).toBe("3 of 12 allowed");
    expect(fill(shellCopy.cs.allowedOf)).toBe("povoleno 3 z 12");
  });

  test("hints name models, not raw model ids", () => {
    for (const language of ["en", "cs"] as const)
      expect(catalogCopy[language].decisionModelHint).not.toMatch(/\//);
  });

  test("external AI app modes say what they do", () => {
    expect([mcpCopy.en.connector, mcpCopy.en.processor]).toEqual([
      "Runs actions",
      "Hands over tasks",
    ]);
    expect([mcpCopy.cs.connector, mcpCopy.cs.processor]).toEqual([
      "Spouští akce",
      "Předává úkoly",
    ]);
  });
});

describe("usage limits save bar", () => {
  test("prices pinned to older models ask for a save, not about edits", () => {
    for (const language of ["en", "cs"] as const) {
      const copy = usageCopy[language];
      expect(
        usageSaveStatus(copy, { error: null, edited: false, stale: 2 }),
      ).toBe(copy.stalePrices);
      expect(
        usageSaveStatus(copy, { error: null, edited: true, stale: 2 }),
      ).toBe(copy.unsavedChanges);
      expect(
        usageSaveStatus(copy, {
          error: "TEST failed",
          edited: false,
          stale: 2,
        }),
      ).toBe("TEST failed");
    }
    expect(usageCopy.en.stalePrices).toBe(
      "Some models changed. Save to update their prices.",
    );
  });
});

describe("overview: needs attention", () => {
  const quiet = { failedToday: 0, retests: 0, requests: 10, limit: 100 };

  test("nothing to look at renders no section", () => {
    expect(needsAttention(quiet)).toEqual([]);
    expect(
      needsAttention({ ...quiet, failedToday: null, retests: null }),
    ).toEqual([]);
  });

  test("failed actions, retests and a near-full limit, in that order", () => {
    expect(
      needsAttention({ failedToday: 3, retests: 1, requests: 85, limit: 100 }),
    ).toEqual([
      { key: "failed", count: 3 },
      { key: "retest", count: 1 },
      { key: "requests", percent: 85 },
    ]);
  });

  test("requests warn from 80 % of a set limit", () => {
    expect(requestsWarning(79, 100)).toBe(false);
    expect(requestsWarning(80, 100)).toBe(true);
    expect(requestsWarning(500, 0)).toBe(false);
    expect(requestShare(1, 3)).toBe(33);
    expect(requestShare(1, 0)).toBeNull();
    expect(needsAttention({ ...quiet, requests: 799, limit: 1000 })).toEqual(
      [],
    );
  });

  test("only today's failures count", () => {
    const now = new Date(2026, 9, 24, 15, 0).getTime();
    const at = (day: number, hour: number) =>
      new Date(2026, 9, day, hour).toISOString();
    expect(
      countToday(
        [
          { createdAt: at(24, 14) },
          { createdAt: at(24, 0) },
          { createdAt: at(23, 23) },
        ],
        now,
      ),
    ).toBe(2);
  });

  test("rows read naturally in both languages", () => {
    expect(plural("en", 3, shellCopy.en.failedToday)).toBe(
      "3 failed actions today",
    );
    expect(plural("cs", 3, shellCopy.cs.failedToday)).toBe(
      "3 akce dnes selhaly",
    );
    expect(plural("cs", 5, shellCopy.cs.retestCount)).toBe(
      "5 procesů čeká na nový test",
    );
    expect(shellCopy.cs.requestsShare.replace("{p}", "85")).toBe(
      "Dotazy na AI dnes na 85 % limitu",
    );
    expect(shellCopy.en.certainty.replace("{p}", "80")).toBe("80 % sure");
  });
});
