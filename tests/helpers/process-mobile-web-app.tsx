import React from "react";
import { createRoot } from "react-dom/client";
import AsyncStorage from "@react-native-async-storage/async-storage";
import App from "../../apps/mobile/App";
import { credentialVault } from "../../apps/mobile/credential-vault";
import { Connections } from "../../packages/client-core/connections";
import type { MobileFixtureSetup } from "./process-mobile-http-child";

type RequestRecord = {
  path: string;
  method: string;
  body: string | null;
  status?: number;
};
type QA = {
  ready: boolean;
  requests: RequestRecord[];
  losses: { request: RequestRecord }[];
  offline: boolean;
  failSaving: boolean;
  failCleanup: boolean;
  storageFailures: string[];
  snapshots: {
    workItems: {
      status: string;
      conversationId: string;
      process?: { status: string; processId: string };
    }[];
  }[];
  loseNext: (type: string) => void;
  remount: () => void;
  pending: () => Promise<{ key: string; value: Record<string, unknown> }[]>;
};

async function main() {
  const bootstrap: {
    origin: string;
    pairing: { address: string; code: string };
    artifact: MobileFixtureSetup["artifact"];
  } = await fetch("/bootstrap").then((r) => r.json());
  const request = window.fetch.bind(window);
  let lose: string | undefined;
  let remount = () => {};
  const qa: QA = {
    ready: false,
    requests: [],
    losses: [],
    offline: false,
    failSaving: false,
    failCleanup: false,
    storageFailures: [],
    snapshots: [],
    loseNext: (type) => {
      lose = type;
    },
    remount: () => remount(),
    pending: async () => {
      const records = [];
      for (const key of (await AsyncStorage.getAllKeys()).filter((k) =>
        k.startsWith("agent-client.command.v2:"),
      )) {
        const value = await AsyncStorage.getItem(key);
        if (value && value !== "null")
          records.push({ key, value: JSON.parse(value) });
      }
      return records;
    },
  };
  Object.assign(window, { niaroProcessQA: qa });
  let appGeneration = 0;
  window.fetch = async (input, init) => {
    const requestGeneration = appGeneration;
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      location.origin,
    );
    if (url.origin !== bootstrap.origin) return request(input, init);
    const body = typeof init?.body === "string" ? init.body : null;
    const item: RequestRecord = {
      path: url.pathname + url.search,
      method: init?.method || "GET",
      body,
    };
    qa.requests.push(item);
    if (qa.offline) throw Error("TEST fixture transport offline");
    const discardAck = !!(
      body &&
      lose &&
      url.pathname.endsWith("/processes/commands") &&
      JSON.parse(body).type === lose
    );
    if (discardAck) lose = undefined;
    // This one fault observer keeps reading the real HTTP ACK even if the
    // client's authoritative event retires/aborts its flight first. It still
    // sends exactly one original request and never returns its ACK to Session.
    const response = await request(
      input,
      discardAck ? { ...init, signal: null } : init,
    );
    item.status = response.status;
    if (
      requestGeneration === appGeneration &&
      url.pathname.endsWith("/snapshot") &&
      response.ok
    ) {
      const snapshot = (await response.clone().json()) as {
        workItems?: {
          status: string;
          conversationId: string;
          native?: { process?: { status: string; provenance: { processId: string } } };
        }[];
      };
      qa.snapshots.push({
        workItems: (snapshot.workItems ?? []).map((work) => ({
          status: work.status,
          conversationId: work.conversationId,
          ...(work.native?.process
            ? {
                process: {
                  status: work.native.process.status,
                  processId: work.native.process.provenance.processId,
                },
              }
            : {}),
        })),
      });
    }
    if (discardAck) {
      // Record the real response headers before consuming the discarded body.
      // Native settlement is verified separately through authoritative reads.
      qa.losses.push({ request: { ...item } });
      await response.text().catch(() => {});
      throw Error("TEST lost HTTP acknowledgement after server processing");
    }
    return response;
  };
  const save = AsyncStorage.setItem.bind(AsyncStorage);
  AsyncStorage.setItem = async (key, value) => {
    if (key.startsWith("agent-client.command.v2:")) {
      if (
        qa.failSaving &&
        value !== "null" &&
        ["accepted", "rejected"].includes(JSON.parse(value).outcome)
      ) {
        qa.storageFailures.push("known-marker");
        throw Error("TEST known outcome marker could not be saved");
      }
      if (qa.failCleanup && value === "null") {
        qa.storageFailures.push("known-cleanup");
        throw Error("TEST known outcome cleanup could not be saved");
      }
    }
    return save(key, value);
  };
  const language = new URLSearchParams(location.search).get("lang") || "en";
  await AsyncStorage.setItem("agent-client.ui-language.v1", language);
  await AsyncStorage.setItem("agent-client.spoken-replies.v1", "off");
  await AsyncStorage.setItem("agent-client.feedback.v1", "off");
  await AsyncStorage.setItem(
    "agent-client.address.v1",
    bootstrap.pairing.address,
  );
  // ConnectionCard offers SSO, not pairing-code controls. Pair via the real
  // Connections API and real /auth/pair, then let actual App restore that vault.
  const connection = new Connections(AsyncStorage, credentialVault, true);
  await connection.restore();
  if (connection.getSnapshot().status !== "connected") {
    if (
      !(await connection.pair(
        bootstrap.pairing.address,
        bootstrap.pairing.code,
      ))
    )
      throw Error("TEST actual Connections pairing failed");
  }
  connection.dispose();
  let root = createRoot(document.getElementById("root")!);
  const render = () => root.render(<App />);
  remount = () => {
    appGeneration++;
    qa.snapshots.length = 0;
    root.unmount();
    root = createRoot(document.getElementById("root")!);
    render();
  };
  render();
  qa.ready = true;
}
void main().catch((error) => {
  console.error(error);
  document.body.dataset.failed = String(error);
});
