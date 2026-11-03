import React from "react";
import { act, render, screen } from "@testing-library/react-native";
import { ClientSession } from "../packages/client-core/session";
import type { MemberService } from "../packages/protocol/member-services";
import {
  MemberServicesView,
  memberServiceCounts,
} from "../packages/ui-catalog/MemberServicesView";
import { memberServicesCopy } from "../packages/ui-catalog/member-services-copy";
import { MemberServices } from "../apps/mobile/ServiceConnection";
import { FixtureEngine } from "../apps/fixture-server/engine";
import { credential, authInfo } from "./auth-fixtures";
import { ListCache } from "../packages/client-core/list-cache";

jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual(
    "@react-native-async-storage/async-storage/jest/async-storage-mock",
  ),
);

const at = Date.UTC(2026, 10, 2, 9, 30);
const company: MemberService = {
  serviceId: "svc-crm",
  name: "Company CRM",
  icon: "users",
  iconSource: "custom",
  own: false,
  reads: {
    account: "company",
    actions: [
      { id: "a1", name: "Find contact", description: "" },
      { id: "a2", name: "Read deals", description: "" },
    ],
  },
  changes: {
    account: "company",
    actions: [{ id: "a3", name: "Update contact", description: "" }],
  },
  signIn: null,
  lastRead: { at },
  lastFailure: { at: at + 60_000, kind: "connection" },
};
const tracker: MemberService = {
  serviceId: "svc-tracker",
  name: "Tracker",
  icon: "folder",
  iconSource: "custom",
  own: false,
  reads: {
    account: "company",
    actions: [{ id: "a4", name: "List issues", description: "" }],
  },
  changes: { account: "own", actions: [] },
  signIn: "disconnected",
  lastRead: null,
  lastFailure: null,
};

test("company-account services are listed read-only, apart from the person's own", () => {
  render(<MemberServicesView language="en" services={[tracker, company]} />);
  const own = screen.getByTestId("member-services-own");
  const shared = screen.getByTestId("member-services-company");
  expect(screen.getByText("Your account")).toBeTruthy();
  expect(screen.getByText("Company account")).toBeTruthy();
  // The tracker reads with the company account and changes with the person's.
  expect(
    screen.getByText(
      "Not connected · Reading: company account · Changes: your account · 1 read",
    ),
  ).toBeTruthy();
  expect(own).toContainElement(screen.getByText("Tracker"));
  expect(shared).toContainElement(screen.getByText("Company CRM"));
  expect(screen.getByText("Company account · 2 reads, 1 change")).toBeTruthy();
  expect(screen.getByText(/^Last read: /)).toBeTruthy();
  expect(
    screen.getByText(/^Last failure: .* · Connection failed$/),
  ).toBeTruthy();
  // Nothing to sign in to, switch or open.
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
});

test("Czech copy, plural forms and the loading, failed and empty states", () => {
  const { rerender } = render(
    <MemberServicesView
      language="cs"
      services={[
        {
          ...company,
          changes: {
            account: "company",
            actions: [
              { id: "b1", name: "A", description: "" },
              { id: "b2", name: "B", description: "" },
            ],
          },
        },
      ]}
    />,
  );
  expect(screen.getByText("Firemní účet")).toBeTruthy();
  expect(screen.getByText("Firemní účet · 2 čtení, 2 změny")).toBeTruthy();
  expect(screen.getByText(/· Spojení selhalo$/)).toBeTruthy();
  expect(screen.queryByText("Tvůj účet")).toBeNull();
  rerender(<MemberServicesView language="cs" />);
  expect(screen.getByText("Načítám…")).toBeTruthy();
  rerender(<MemberServicesView language="cs" failed />);
  expect(screen.getByText("Služby se nepodařilo načíst.")).toBeTruthy();
  rerender(<MemberServicesView language="cs" services={[]} />);
  expect(screen.getByText("Zatím žádné služby.")).toBeTruthy();
});

test("EN and CS copy have the same keys", () => {
  const keys = (value: object): string[] =>
    Object.entries(value).flatMap(([key, entry]) =>
      typeof entry === "object"
        ? keys(entry as object).map((inner) => `${key}.${inner}`)
        : [key],
    );
  expect(keys(memberServicesCopy.cs)).toEqual(keys(memberServicesCopy.en));
});

test("the phone list follows the current connection and hides on a server without it", async () => {
  let finish: (value: unknown) => void = () => {};
  const old = {
    readMemberServices: jest.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ),
  };
  const next = {
    readMemberServices: jest.fn(async () => ({
      organizationId: "org",
      workspaceId: "ws",
      services: [company],
    })),
  };
  const view = render(
    <MemberServices session={old as unknown as ClientSession} language="en" />,
  );
  expect(screen.getByText("Loading…")).toBeTruthy();
  const signal = (
    old.readMemberServices.mock.calls[0] as unknown as [AbortSignal]
  )[0];
  view.rerender(
    <MemberServices session={next as unknown as ClientSession} language="en" />,
  );
  expect(signal.aborted).toBe(true);
  await act(async () => {
    finish({ organizationId: "org", workspaceId: "ws", services: [tracker] });
  });
  expect(await screen.findByText("Company CRM")).toBeTruthy();
  expect(screen.queryByText("Tracker")).toBeNull();

  const missing = { readMemberServices: jest.fn(async () => null) };
  view.rerender(
    <MemberServices
      session={missing as unknown as ClientSession}
      language="en"
    />,
  );
  await act(async () => {});
  expect(view.toJSON()).toBeNull();

  const failing = {
    readMemberServices: jest.fn(async () => {
      throw new Error("connection_failed");
    }),
  };
  view.rerender(
    <MemberServices
      session={failing as unknown as ClientSession}
      language="en"
    />,
  );
  expect(await screen.findByText("Couldn't load the services.")).toBeTruthy();
});

test("Settings shows the last known services, reads them once within two minutes and keeps them when a read fails", async () => {
  const values = new Map<string, string>();
  let now = Date.UTC(2026, 10, 3, 9);
  const lists = new ListCache(
    {
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => {
        values.set(key, value);
      },
      removeItem: async (key) => {
        values.delete(key);
      },
    },
    () => now,
  );
  const signedIn = {
    identityKey: "TEST-server|alice",
    readMemberServices: jest.fn(async () => ({
      organizationId: "org",
      workspaceId: "ws",
      services: [company],
    })),
  };
  const settings = () => (
    <MemberServices
      session={signedIn as unknown as ClientSession}
      language="en"
      lists={lists}
    />
  );
  const first = render(settings());
  expect(await screen.findByText("Company CRM")).toBeTruthy();
  first.unmount();
  now += 60_000;
  render(settings());
  // Shown at once from this session, without asking again.
  expect(screen.getByText("Company CRM")).toBeTruthy();
  await act(async () => {});
  expect(signedIn.readMemberServices).toHaveBeenCalledTimes(1);
  screen.unmount();

  // The next app run: the device copy stands in, also for a failed read.
  const nextRun = {
    identityKey: "TEST-server|alice",
    readMemberServices: jest.fn(async () => {
      throw new Error("connection_failed");
    }),
  };
  render(
    <MemberServices
      session={nextRun as unknown as ClientSession}
      language="en"
      lists={lists}
    />,
  );
  expect(await screen.findByText("Company CRM")).toBeTruthy();
  await act(async () => {});
  expect(nextRun.readMemberServices).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Couldn't load the services.")).toBeNull();
});

describe("ClientSession.readMemberServices", () => {
  const response = (value: unknown, status = 200) =>
    ({
      ok: status < 400,
      status,
      text: async () => JSON.stringify(value),
    }) as Response;
  async function setup(services: () => Response) {
    const engine = new FixtureEngine();
    const transport = jest.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/auth/session")) return response(authInfo());
      if (new URL(String(url)).pathname.endsWith("/services"))
        return services();
      return response(engine.snapshot());
    }) as jest.MockedFunction<typeof fetch>;
    const session = new ClientSession(
      "https://fixture/v1/a",
      { getItem: async () => null, setItem: async () => {} },
      credential(),
      transport,
    );
    await session.start(false);
    return { session, transport };
  }
  const scope = credential().scope;

  test("reads the person's projection with a GET and checks the workspace", async () => {
    const { session, transport } = await setup(() =>
      response({
        organizationId: "TEST-org",
        workspaceId: scope.workspaceId,
        services: [company],
      }),
    );
    try {
      const list = await session.readMemberServices();
      expect(list?.services).toEqual([company]);
      const call = transport.mock.calls.find(([url]) =>
        new URL(String(url)).pathname.endsWith("/services"),
      )!;
      expect(call[1]?.method ?? "GET").toBe("GET");
    } finally {
      session.stop();
    }
  });

  test("another workspace's list is refused; a server without it answers null", async () => {
    let reply = () =>
      response({
        organizationId: "TEST-org",
        workspaceId: "33333333-3333-4333-8333-333333333333",
        services: [],
      });
    const { session } = await setup(() => reply());
    try {
      await expect(session.readMemberServices()).rejects.toThrow(
        "invalid_payload",
      );
      reply = () => response({ error: "not_found" }, 404);
      await expect(session.readMemberServices()).resolves.toBeNull();
      reply = () => response({ error: "internal" }, 500);
      await expect(session.readMemberServices()).rejects.toThrow(
        "connection_failed",
      );
    } finally {
      session.stop();
    }
  });
});

test("counts read without Intl.PluralRules, which Hermes on the phone lacks", () => {
  const intl = Intl as { PluralRules?: typeof Intl.PluralRules };
  const plural = intl.PluralRules;
  delete intl.PluralRules;
  try {
    expect(memberServiceCounts(company, "cs")).toBe("2 čtení, 1 změna");
    expect(
      memberServiceCounts(
        { ...company, changes: { ...company.changes, actions: [] } },
        "en",
      ),
    ).toBe("2 reads");
  } finally {
    intl.PluralRules = plural;
  }
});
