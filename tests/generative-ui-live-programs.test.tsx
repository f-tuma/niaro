import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { render } from "@testing-library/react-native";
import { GeneratedUi } from "../apps/server-admin/web/app/generative-ui";
import { GenerativeUiView } from "../packages/ui-catalog/GenerativeUiView";
import { checkProgram } from "../packages/openui-library/program";
import live from "./fixtures/generative-ui-live-programs.json";

// Programs a live model wrote in the ui.* trust matrix render on both clients.
jest.mock("recharts", () =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule(),
);
jest.mock(
  "@admin/components/ui/chart",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/select",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
jest.mock("../apps/server-admin/web/app/context", () => ({
  useApp: () => ({ language: "cs" }),
}));
beforeAll(() => {
  Object.defineProperty(globalThis, "window", {
    value: globalThis,
    configurable: true,
  });
});

/** The rendered tree with its props, so chart labels count as shown. */
const shown = (tree: unknown) => {
  const seen = new WeakSet<object>();
  return JSON.stringify(tree, (_key, value: unknown) => {
    if (typeof value === "function") return undefined;
    if (value && typeof value === "object") {
      if (seen.has(value)) return undefined;
      seen.add(value);
    }
    return value;
  }).replace(/\\u00a0|\u00a0/g, " ");
};

test.each(live.programs.map((entry) => [entry.id, entry] as const))(
  "%s renders on the web and the phone",
  async (_id, entry) => {
    expect(checkProgram(entry.program).ok).toBe(true);
    expect(entry.shows.length).toBeGreaterThan(0);

    let web!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      web = TestRenderer.create(
        <GeneratedUi program={entry.program} onFollowUp={jest.fn()} />,
      );
    });
    await act(async () => {});
    const webTree = shown(web.toJSON());
    for (const value of entry.shows) expect(webTree).toContain(value);

    const phone = render(
      <GenerativeUiView
        program={entry.program}
        language={entry.language as "en" | "cs"}
        onFollowUp={jest.fn()}
        onOpenUrl={jest.fn()}
      />,
    );
    const phoneTree = shown(phone.toJSON());
    for (const value of entry.shows) expect(phoneTree).toContain(value);
    phone.unmount();
    web.unmount();
  },
);
