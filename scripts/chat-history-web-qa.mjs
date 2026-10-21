import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createFixtureServer } from "../apps/fixture-server/http.ts";
import { issuePairingCode } from "../apps/fixture-server/auth.ts";
import { en, cs } from "../packages/i18n/index.ts";
const module = process.env.NIARO_PLAYWRIGHT_MODULE;
const { chromium } = await import(
  module ? pathToFileURL(resolve(module)).href : "playwright"
);
const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.env.NIARO_CHAT_QA_OUTPUT
  ? resolve(process.env.NIARO_CHAT_QA_OUTPUT)
  : mkdtempSync(resolve(tmpdir(), "niaro-chat-history-web-"));
mkdirSync(output, { recursive: true });
const helper = (name) =>
  resolve(cwd, "tests/helpers/process-mobile-web-" + name);
const bundled = await build({
  absWorkingDir: cwd,
  entryPoints: [helper("app.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  outfile: resolve(output, "app.js"),
  metafile: true,
  alias: {
    "react-native": "react-native-web",
    "react-native-svg": resolve(
      cwd,
      "node_modules/react-native-svg/lib/module/ReactNativeSVG.web.js",
    ),
    "expo-crypto": helper("crypto.ts"),
    "expo-secure-store": helper("secure-store.ts"),
  },
  plugins: [
    {
      name: "test-native-peripherals",
      setup(api) {
        api.onResolve({ filter: /async-require\/setup$/ }, (args) => {
          if (args.importer.includes("/expo/"))
            return { path: helper("metro.ts") };
        });
        api.onResolve(
          {
            filter:
              /^(\.\/|.*\/apps\/mobile\/)(ReplySpeech|voice-capture|app-login|feedback)$/,
          },
          (args) => {
            if (args.importer.includes("/apps/mobile/"))
              return { path: helper("peripherals.ts") };
          },
        );
      },
    },
  ],
  resolveExtensions: [
    ".web.tsx",
    ".web.ts",
    ".web.js",
    ".tsx",
    ".ts",
    ".js",
    ".json",
  ],
  define: {
    "process.env.NODE_ENV": '"development"',
    "process.env.EXPO_OS": '"web"',
    "process.env.EXPO_PUBLIC_ALLOW_INSECURE_FIXTURES": '"1"',
    __DEV__: "true",
  },
  banner: {
    js: 'var process = {env:{NODE_ENV:"development",EXPO_PUBLIC_ALLOW_INSECURE_FIXTURES:"1"}};',
  },
  logLevel: "warning",
});

const owned = [
  "apps/fixture-server/conversation-history.ts",
  "apps/fixture-server/conversation-memory.ts",
  "apps/fixture-server/storage.ts",
  "apps/fixture-server/engine.ts",
  "apps/fixture-server/http.ts",
  "apps/fixture-server/model-service.ts",
  "apps/mobile/App.tsx",
  "apps/mobile/ChatHistory.tsx",
  "apps/mobile/VoiceReply.tsx",
  "apps/mobile/chat-session.ts",
  "packages/client-core/session.ts",
  "packages/client-core/automatic-speech.ts",
  "packages/client-core/conversation-preferences.ts",
  "packages/protocol/index.ts",
  "packages/i18n/index.ts",
  "packages/ui/index.tsx",
  "scripts/chat-history-web-qa.mjs",
];
const all = [
  ...new Set([
    ...owned,
    "apps/server-identity/service-catalog.ts",
    "apps/server-identity/mastra-domain.ts",
    "apps/server-identity/mastra-runtime.ts",
    "apps/server-identity/service.ts",
    ...Object.keys(bundled.metafile.inputs).filter(
      (p) => !p.includes("node_modules"),
    ),
  ]),
].sort();
const fingerprint = (paths) =>
  Object.fromEntries(
    paths.map((p) => [
      p,
      createHash("sha256")
        .update(readFileSync(resolve(cwd, p)))
        .digest("hex"),
    ]),
  );
const before = fingerprint(all),
  ownedBefore = fingerprint(owned);
const results = {
  cases: [],
  checks: 0,
  errors: [],
  warnings: [],
  external: [],
  captures: [],
  sourceBefore: before,
  sourceAfter: null,
  ownedStable: false,
  wholeStable: false,
};
const check = (value, message) => {
  results.checks++;
  assert(value, message);
};
const browser = await chromium.launch({ headless: true });
try {
  for (const { language, width } of [
    { language: "en", width: 1100 },
    { language: "cs", width: 390 },
  ]) {
    const tr = language === "cs" ? cs : en;
    const directory = mkdtempSync(resolve(tmpdir(), "TEST-chat-http-"));
    let bootstrap,
      modelCalls = 0;
    const web = createServer((req, res) => {
      if (req.url === "/bootstrap") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(bootstrap));
      } else if (req.url === "/app.js") {
        res.setHeader("Content-Type", "text/javascript");
        res.end(readFileSync(resolve(output, "app.js")));
      } else {
        res.setHeader("Content-Type", "text/html");
        res.end(
          '<!doctype html><html><head><title>TEST Niaro chat history</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0;background:#eef2f7;font-family:Arial}#root{display:flex;min-width:0}*{box-sizing:border-box}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
        );
      }
    });
    await new Promise((done, reject) => {
      web.once("error", reject);
      web.listen(0, "127.0.0.1", done);
    });
    const origin = "http://127.0.0.1:" + web.address().port;
    const fixture = createFixtureServer(directory, [origin], {
      model: {
        timeZone: "UTC",
        decide: async (input) => {
          modelCalls++;
          return {
            kind: "reply",
            contactId: null,
            title: null,
            localStart: null,
            durationMinutes: null,
            reply: "TEST reply " + input.text,
          };
        },
      },
    });
    await new Promise((done, reject) => {
      fixture.once("error", reject);
      fixture.listen(0, "127.0.0.1", done);
    });
    const fixtureOrigin = "http://127.0.0.1:" + fixture.address().port;
    bootstrap = {
      origin: fixtureOrigin,
      pairing: {
        address: fixtureOrigin + "/v1/a",
        code: issuePairingCode(directory, "test-alice", "a"),
      },
      artifact: null,
    };
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      reducedMotion: "reduce",
    });
    try {
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if ([origin, fixtureOrigin].includes(url.origin))
          return route.continue();
        results.external.push(url.origin);
        return route.abort();
      });
      const page = await context.newPage();
      page.on("pageerror", (e) => results.errors.push(String(e)));
      page.on("console", (m) => {
        if (
          m.type() === "error" &&
          m.text().includes("404") &&
          m.location().url.includes("/processes/output/capabilities")
        )
          results.warnings.push(
            "Expected fixture404: process output capability discovery is unsupported.",
          );
        else if (
          m.type() === "error" &&
          m.text().includes("404") &&
          m.location().url.includes("/human-tasks")
        )
          results.warnings.push(
            "Expected fixture404: this fixture serves no human tasks.",
          );
        else if (m.type() === "error")
          results.errors.push(m.text() + " " + m.location().url);
        else if (m.type() === "warning") results.warnings.push(m.text());
      });
      const capture = async (name) => {
        const path = resolve(output, `${language}-${width}-${name}.png`);
        await page.screenshot({ path, fullPage: false });
        results.captures.push(path);
      };
      await page.goto(origin + "/?lang=" + language);
      await page.waitForFunction(() => window.niaroProcessQA?.ready);
      await page.getByRole("button", { name: tr.menu, exact: true }).waitFor();
      check(
        (await page.title()) === "TEST Niaro chat history",
        "expected page identity",
      );
      check(
        (await page.locator("body").innerText()).length > 30,
        "meaningful nonblank app",
      );
      check(
        (await page.evaluate(() => window.niaroProcessQA.requests)).every(
          (r) => !r.path.includes("conversations"),
        ),
        "no automatic history reads",
      );
      // Bootstrap readiness precedes the actual session's online snapshot.
      await page.waitForFunction((label) => {
        const button = [...document.querySelectorAll('[role="button"]')].find(
          (element) => element.getAttribute("aria-label") === label,
        );
        return button && button.getAttribute("aria-disabled") !== "true";
      }, tr.newChat);
      check(
        await page
          .getByRole("button", { name: tr.newChat, exact: true })
          .isEnabled(),
        "header New chat is enabled on the empty online home",
      );
      await capture("empty-home-new-chat-enabled");
      const commands = async () =>
        page.evaluate(() =>
          window.niaroProcessQA.requests
            .filter((r) => r.body && r.path.includes("/commands"))
            .map((r) => JSON.parse(r.body)),
        );
      const open = async () => {
        const previous = modelCalls;
        await page.getByRole("button", { name: tr.menu, exact: true }).click();
        await page
          .getByRole("button", { name: tr.newChat, exact: true })
          .first()
          .waitFor();
        await page
          .getByText(tr.loading, { exact: true })
          .waitFor({ state: "hidden" });
        await page.waitForFunction(() => {
          const panel = document.querySelector(
            '[data-testid="chat-history-panel"]',
          );
          const drawer = panel?.lastElementChild;
          return drawer && Math.abs(drawer.getBoundingClientRect().y) < 1;
        });
        check(modelCalls === previous, "passive history open has no inference");
      };
      await open();
      const panel = page.getByTestId("chat-history-panel");
      const drawer = panel.locator(":scope > div").last();
      const geometry = await drawer.boundingBox();
      check(
        Math.abs(geometry.x) < 1 &&
          geometry.width <= 341 &&
          Math.abs(geometry.y) < 1 &&
          Math.abs(geometry.height - 900) < 1,
        "menu drawer aligns to viewport LEFT with bounded width",
      );
      const trigger = await page
        .getByRole("button", {
          name: tr.menu,
          exact: true,
          includeHidden: true,
        })
        .boundingBox();
      check(
        trigger.x < width / 2,
        "menu opener sits on the app left, beside its drawer",
      );
      await capture("empty-left-drawer");
      const create = async (fromHeader = false) => {
        const previous = modelCalls;
        const before = (await commands()).length;
        if (fromHeader) {
          await page.keyboard.press("Escape");
          await panel.waitFor({ state: "hidden" });
        }
        await page
          .getByRole("button", { name: tr.newChat, exact: true })
          .first()
          .click();
        await panel.waitFor({ state: "hidden" });
        await page
          .getByRole("textbox", { name: tr.composer, exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: tr.newChat, exact: true })
          .waitFor();
        await page.waitForTimeout(300);
        // The chat is saved by its first message, not by the tap.
        check(
          (await commands()).length === before,
          "New chat stays on this device until its first message",
        );
        check(modelCalls === previous, "explicit new chat starts no model");
      };
      const send = async (text) => {
        await page
          .getByRole("textbox", { name: tr.composer, exact: true })
          .fill(text);
        await page.getByRole("button", { name: tr.send, exact: true }).click();
        await page.getByText("TEST reply " + text, { exact: true }).waitFor();
      };
      await create(true);
      await send("TEST chat A text");
      await open();
      await create();
      await send("TEST chat B text");
      const sent = await commands();
      const created = sent.filter((c) => c.type === "conversation.create");
      check(
        created.length === 2 &&
          created[0].conversationId !== created[1].conversationId,
        "explicit stable distinct public IDs",
      );
      check(
        sent.filter((c) => c.type === "message.send").every((c) => !c.session),
        "new public chats never implicitly reset session",
      );
      await open();
      const a = page.getByRole("button", {
        name: "TEST chat A text",
        exact: true,
      });
      // Pinning lives in the row's long-press menu, not on a row icon.
      const box = await a.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(600);
      await page.mouse.up();
      await page
        .getByRole("menuitem", { name: tr.pinChat, exact: true })
        .click();
      await page.getByText(tr.pinnedChats, { exact: true }).waitFor();
      await capture("pinned-left-drawer");
      await page.keyboard.press("Escape");
      await panel.waitFor({ state: "hidden" });
      check(
        await page
          .getByRole("button", { name: tr.menu, exact: true })
          .evaluate((element) => element === document.activeElement),
        "Escape returns focus to the menu trigger",
      );
      await page.evaluate(() => window.niaroProcessQA.remount());
      await page.getByRole("button", { name: tr.menu, exact: true }).waitFor();
      await open();
      await page.getByText(tr.pinnedChats, { exact: true }).waitFor();
      const titles = await panel.getByRole("button").allTextContents();
      check(
        titles.findIndex((t) => t.includes("TEST chat A text")) <
          titles.findIndex((t) => t.includes("TEST chat B text")),
        "pin survives actual App remount and orders first",
      );
      await page
        .getByRole("button", { name: "TEST chat A text", exact: true })
        .click();
      await panel.waitFor({ state: "hidden" });
      await page
        .getByText("TEST reply TEST chat A text", { exact: true })
        .waitFor();
      check(
        (await commands()).length === sent.length,
        "opening transcript performs no commands/replay/task selection",
      );
      await capture("reopened-A-transcript");
      await open();
      await page
        .getByRole("button", { name: "TEST chat B text", exact: true })
        .click();
      await page
        .getByText("TEST reply TEST chat B text", { exact: true })
        .waitFor();
      check(
        modelCalls === 2,
        "only the two explicit text requests invoked fixture decision stub",
      );
      check(
        !(await page.locator('[data-testid="error-overlay"]').count()),
        "no framework overlay",
      );
      results.cases.push({
        language,
        width,
        modelCalls,
        commands: sent.length,
        geometry,
      });
    } finally {
      await context.close();
      fixture.closeIdleConnections();
      await new Promise((done) => fixture.close(done));
      web.closeIdleConnections();
      await new Promise((done) => web.close(done));
      rmSync(directory, { recursive: true, force: true });
    }
  }
  results.sourceAfter = fingerprint(all);
  results.wholeStable =
    JSON.stringify(results.sourceBefore) ===
    JSON.stringify(results.sourceAfter);
  results.ownedStable =
    JSON.stringify(ownedBefore) === JSON.stringify(fingerprint(owned));
  check(
    results.ownedStable,
    "history-owned sources remained unchanged during rendered proof",
  );
  check(results.external.length === 0, "no external network");
  check(results.errors.length === 0, "console and page errors absent");
} finally {
  await browser.close();
  writeFileSync(
    resolve(output, "results.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(
    JSON.stringify({
      output,
      ...results,
      sourceBefore: undefined,
      sourceAfter: undefined,
    }),
  );
}
