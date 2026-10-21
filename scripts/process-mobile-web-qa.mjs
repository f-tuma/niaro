import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { mobileHttpChildFixture } from "../tests/helpers/process-mobile-http-child.ts";
import { en, cs } from "../packages/i18n/index.ts";

// Optional externally installed Playwright; no dependency install or live calls.
const playwrightModule = process.env.NIARO_PLAYWRIGHT_MODULE;
const { chromium } = await import(
  playwrightModule
    ? pathToFileURL(resolve(playwrightModule)).href
    : "playwright"
);
const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.env.NIARO_PROCESS_QA_OUTPUT
  ? resolve(process.env.NIARO_PROCESS_QA_OUTPUT)
  : mkdtempSync(resolve(tmpdir(), "niaro-process-http-web-"));
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
const sourcePaths = [
  ...new Set([
    ...Object.keys(bundled.metafile.inputs).filter(
      (p) => !p.includes("node_modules"),
    ),
    "scripts/process-mobile-web-qa.mjs",
    "tests/helpers/process-mobile-http-child.ts",
    "tests/helpers/process-mobile-http-worker.ts",
    "tests/helpers/process-mobile-integrated-http.ts",
    "tests/helpers/process-coordinator-http.ts",
    "tests/helpers/process-design-http.ts",
  ]),
]
  .map((p) => resolve(cwd, p))
  .sort();
const fingerprint = () =>
  Object.fromEntries(
    sourcePaths.map((p) => [
      p.slice(cwd.length + 1),
      createHash("sha256").update(readFileSync(p)).digest("hex"),
    ]),
  );
const sourceBefore = fingerprint();
const browser = await chromium.launch({ headless: true });
const results = {
  cases: [],
  checks: 0,
  external: 0,
  errors: [],
  warnings: [],
  expectedHTTPRejections: [],
  captures: [],
  sourceFiles: sourcePaths.length,
  physicalAndroid: false,
  nativeVoiceAndSSO: false,
};
const check = (condition, message) => {
  results.checks++;
  assert(condition, message);
};
const equal = (actual, expected, message) => {
  results.checks++;
  assert.deepEqual(actual, expected, message);
};
const chosen = process.env.NIARO_PROCESS_QA_CASES?.split(",");
const cases = [];
for (const language of ["en", "cs"]) {
  for (const width of [320, 390, 700])
    cases.push({ name: "happy", language, width });
  for (const name of [
    "deny",
    "service_failed",
    "service_unknown",
    "invalid_output",
    "lost-start",
    "lost-answer",
    "lost-approval",
    "marker-offline",
    "cleanup-offline",
    "long-review",
    "service-revoked",
  ]) {
    cases.push({ name, language, width: name === "long-review" ? 320 : 390 });
  }
}

async function run(test) {
  const { name, language, width } = test;
  const tr = language === "cs" ? cs : en;
  const label = `${name}-${width}-${language}`;
  let fixture, context, page, bootstrap;
  const server = createServer((req, res) => {
    if (req.url === "/bootstrap") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(bootstrap));
    } else if (req.url === "/app.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(readFileSync(resolve(output, "app.js")));
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0;background:#eef2f7;font-family:Arial}#root{display:flex;min-width:0}*{box-sizing:border-box}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
      );
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = "http://127.0.0.1:" + server.address().port;
  const caseStart = results.checks;
  const capture = async (suffix) => {
    const path = resolve(output, label + "-" + suffix + ".png");
    await page.screenshot({ path, fullPage: true });
    results.captures.push(path);
  };
  try {
    fixture = await mobileHttpChildFixture({
      cwd,
      testAllowedOrigins: [origin],
    });
    const questions = name === "happy" ? 2 : name === "lost-answer" ? 2 : 0;
    const writes = name === "lost-start" || name === "lost-answer" ? 0 : 2;
    const setup = await fixture.configure({
      questions,
      writes,
      outcome: ["service_failed", "service_unknown", "invalid_output"].includes(
        name,
      )
        ? name
        : "success",
      parameterPadding:
        name === "long-review"
          ? "TEST dlouhý parametr 👩‍💻 ".repeat(200) + "TEST parameter end"
          : "",
    });
    bootstrap = {
      origin: fixture.origin,
      pairing: await fixture.issuePairing(),
      artifact: setup.artifact,
    };
    context = await browser.newContext({
      viewport: { width, height: 1000 },
      reducedMotion: "reduce",
    });
    await context.route("**/*", (route) => {
      if (
        [origin, fixture.origin].includes(new URL(route.request().url()).origin)
      )
        return route.continue();
      results.external++;
      return route.abort();
    });
    page = await context.newPage();
    page.on("pageerror", (e) =>
      results.errors.push({ case: label, error: String(e) }),
    );
    page.on("console", (m) => {
      if (m.type() === "error") {
        if (
          name === "service-revoked" &&
          m.text() ===
            "Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)"
        )
          results.expectedHTTPRejections.push({
            case: label,
            status: 422,
            message: m.text(),
          });
        else results.errors.push({ case: label, error: m.text() });
      }
      // Chromium emits this driver warning while Playwright captures screenshots;
      // it is unrelated to the rendered app and only appears in the test runtime.
      if (
        m.type() === "warning" &&
        !m.text().includes("GPU stall due to ReadPixels")
      )
        results.warnings.push({ case: label, warning: m.text() });
    });
    await page.goto(origin + "/?lang=" + language);
    await page.waitForFunction(
      () => window.niaroProcessQA?.ready || document.body.dataset.failed,
      null,
      { timeout: 30_000 },
    );
    check(
      !(await page.locator("body").getAttribute("data-failed")),
      "actual App bootstrap completed",
    );
    await page.evaluate(() => {
      const events = [];
      const ids = new WeakMap();
      let nextId = 0;
      const identify = (node) => {
        if (!ids.has(node)) ids.set(node, ++nextId);
        return {
          id: ids.get(node),
          tag: node.tagName,
          label: node.getAttribute("aria-label"),
        };
      };
      Object.assign(window, { niaroFocusQA: events });
      for (const type of ["focusin", "focusout"])
        document.addEventListener(type, (event) =>
          events.push({
            type,
            at: performance.now(),
            ...identify(event.target),
          }),
        );
      new MutationObserver((mutations) => {
        for (const mutation of mutations)
          for (const [type, nodes] of [
            ["added", mutation.addedNodes],
            ["removed", mutation.removedNodes],
          ])
            for (const node of nodes) {
              if (!(node instanceof Element)) continue;
              const inputs = [
                ...(node.matches("textarea") ? [node] : []),
                ...node.querySelectorAll("textarea"),
              ];
              for (const input of inputs)
                events.push({
                  type,
                  at: performance.now(),
                  ...identify(input),
                });
            }
      }).observe(document.getElementById("root"), {
        childList: true,
        subtree: true,
      });
    });
    const button = (key) =>
      page.getByRole("button", { name: tr[key], exact: true });
    const waitEnabled = async (control) => {
      await control.waitFor();
      const deadline = Date.now() + 15_000;
      while (!(await control.isEnabled())) {
        assert(Date.now() < deadline, "saved command flight did not settle");
        await new Promise((done) => setTimeout(done, 50));
      }
    };
    const waitLoss = async (type) => {
      await page.waitForFunction(
        (type) =>
          window.niaroProcessQA.losses.some(
            (loss) =>
              loss.request.status === 202 &&
              JSON.parse(loss.request.body).type === type,
          ),
        type,
      );
      check(true, "injected loss follows an actual accepted HTTP response");
    };
    const posts = async () =>
      (await fixture.inspect()).requests.filter(
        (r) => r.method === "POST" && r.body,
      );
    const counts = async () => {
      const x = await fixture.inspect();
      return {
        model: x.modelCalls,
        service: x.serviceDispatches.length,
        command: x.commandPosts,
        ordinary: x.ordinaryCommandPosts,
      };
    };
    const outputLabel = tr.processOutputTitle;
    const actionsLabel =
      language === "cs" ? "Uložené akce (2)" : "Recorded actions (2)";
    const showOutput = async () => {
      await page
        .getByRole("button", { name: outputLabel, exact: true })
        .click();
      await page
        .getByText("TEST integrated result", { exact: false })
        .first()
        .waitFor();
    };
    const approval = async (n) => {
      await page
        .getByTestId("service-action-parameters")
        .filter({ hasText: `TEST write ${n}` })
        .waitFor();
    };
    const finish = async () => {
      await page
        .getByText(tr.nativeSucceeded, { exact: true })
        .first()
        .waitFor();
      await showOutput();
    };
    const verifyTerminal = async () => {
      const declined = [
        "deny",
        "lost-approval",
        "marker-offline",
        "cleanup-offline",
      ].includes(name);
      const status =
        name === "service_unknown"
          ? tr.processUnknown
          : declined
            ? tr.cancelled
            : tr.failed;
      await page.getByText(status, { exact: true }).first().waitFor();
      const actions = page.getByRole("button", {
        name: actionsLabel,
        exact: true,
      });
      await actions.waitFor();
      if ((await actions.getAttribute("aria-expanded")) !== "true")
        await actions.click();
      const text = await page.locator("body").innerText();
      const first =
        language === "cs" ? "· Zápis · Dokončeno" : "· Write · Completed";
      equal(
        text.split(first).length - 1,
        name === "invalid_output" ? 2 : 1,
        "canonical succeeded receipts remain visible",
      );
      const second = declined
        ? language === "cs"
          ? "· Zápis · Odmítnuto"
          : "· Write · Rejected"
        : name === "service_unknown"
          ? language === "cs"
            ? "· Zápis · Nepotvrzeno"
            : "· Write · Unconfirmed"
          : language === "cs"
            ? "· Zápis · Selhalo"
            : "· Write · Failed";
      if (name !== "invalid_output")
        equal(
          text.split(second).length - 1,
          1,
          "second receipt has its actual localized failed/unknown/rejected status",
        );
      if (name === "invalid_output")
        check(
          text.includes("process_output_invalid"),
          "output failure exposes concrete reason after succeeded writes",
        );
      check(
        !text.includes(
          language === "cs" ? "Proces byl dokončen." : "The process completed.",
        ),
        "failed/unknown/declined process is not advertised as completed",
      );
      equal(
        await counts(),
        {
          model: name === "invalid_output" ? 3 : 2,
          service: declined || name === "service_failed" ? 1 : 2,
          command: name === "lost-approval" ? 4 : 3,
          ordinary: 0,
        },
        "fault/decline flow has exact canonical dispatch counts",
      );
    };
    const saved = page.getByTestId("saved-process-approval");
    let reopenedPendingAnswer = false;
    const openProcessRunHistory = async () => {
      await button("menu").click();
      const processNavigation = page.getByRole("button", {
        name: tr.processesTitle,
        exact: true,
      });
      if (await processNavigation.isVisible()) await processNavigation.click();
      else await button("processesOpenSaved").click();
      const run = page.getByTestId(/^process-run-history-/).first();
      await run.waitFor();
      await run.click();
      return page.getByTestId("process-run-history-detail");
    };
    await button("menu").click();
    await button("processesTitle").click();
    await button("processesLoad").click();
    await page
      .getByRole("radio", {
        name: tr.processesSelect + ": " + setup.artifact.definition.name,
        exact: true,
      })
      .click();
    await button("processesPrepare").click();
    const editor = page.getByTestId("process-input-card");
    await editor.waitFor();
    await page
      .getByRole("textbox", { name: "name", exact: true })
      .fill("  TEST browser typed input");
    await editor.getByRole("button").last().click();
    await page.getByTestId("process-launch-review").waitFor();
    await page
      .getByTestId("process-launch-review")
      .getByRole("button", { name: tr.processesDetails, exact: true })
      .click();
    check(
      (await page.getByTestId("process-launch-input").innerText()).includes(
        "  TEST browser typed input",
      ),
      "review retains typed input",
    );
    equal(
      await counts(),
      { model: 0, service: 0, command: 0, ordinary: 0 },
      "pairing/render/form/review is passive",
    );
    if (name === "happy") await capture("review");
    if (name === "lost-start")
      await page.evaluate(() =>
        window.niaroProcessQA.loseNext("process.start"),
      );
    if (name === "service-revoked") await fixture.disableService();
    await button("processesStart").click();
    if (name === "service-revoked") {
      await page.getByText(tr.processesRejected, { exact: true }).waitFor();
      equal(
        (await posts()).map((r) => r.status),
        [422],
        "current dependency change produces the expected actual HTTP 422 rejection",
      );
      equal(
        await counts(),
        { model: 0, service: 0, command: 1, ordinary: 0 },
        "current service gate rejects frozen start without dispatch",
      );
      await capture("rejected");
      results.cases.push({ ...test, checks: results.checks - caseStart });
      return;
    }
    if (name === "lost-start") {
      await page.getByText(tr.processesUnknown, { exact: true }).waitFor();
      await waitLoss("process.start");
      await waitEnabled(button("processesRetrySame"));
      // Lost admission ACK precedes background execution completion. Wait for
      // real persisted Loops state before restarting this success/replay case;
      // restarting an active run would correctly test cancellation instead.
      const deadline = Date.now() + 15_000;
      let loop;
      while (!loop) {
        const read = await fixture.loops();
        equal(read.status, 200, "authenticated Loops read succeeds");
        loop = read.data.entries.find(
          (entry) =>
            entry.process?.processId === setup.artifact.processId &&
            entry.status === "succeeded",
        );
        assert(
          Date.now() < deadline,
          "lost start did not reach persisted succeeded run",
        );
        if (!loop) await new Promise((done) => setTimeout(done, 50));
      }
      equal(
        loop.process.artifactDigest,
        setup.artifact.digest,
        "actual Loops matches the started artifact",
      );
      const beforeRetry = await counts();
      await fixture.restart();
      await page.evaluate(() => window.niaroProcessQA.remount());
      // The server completed the admitted run while the original ACK was lost.
      // A fresh client must preserve the authoritative result and never replay
      // the start. Assert the reopened projection below; the new-chat boundary
      // may hide old work UI (tracked separately in NIAR-157).
      const commands = await posts();
      equal(commands.length, 1, "completed lost-ACK start is not replayed");
      equal(
        await counts(),
        beforeRetry,
        "completed run restore has no new command/model/service dispatch",
      );
      await page.waitForFunction(() =>
        window.niaroProcessQA.snapshots.some((snapshot) =>
          snapshot.workItems.some(
            (work) => work.process?.status === "succeeded",
          ),
        ),
      );
      const postsBeforeHistory = await posts();
      await openProcessRunHistory();
      await finish();
      equal(
        await posts(),
        postsBeforeHistory,
        "reopened completed run history is read-only",
      );
      await capture("retry");
      results.cases.push({ ...test, checks: results.checks - caseStart });
      return;
    }
    await page.getByText(tr.processesAccepted, { exact: true }).waitFor();
    await button("close").click();
    for (let n = 1; n <= questions; n++) {
      await page
        .getByText(`TEST question ${n}?`, { exact: true })
        .first()
        .waitFor();
      if (!(name === "lost-answer" && n === 2 && reopenedPendingAnswer))
        await button("replyInChat").first().click();
      const composer = page.getByRole("textbox", {
        name: tr.composer,
        exact: true,
      });
      await page.waitForFunction(
        (label) => document.activeElement?.getAttribute("aria-label") === label,
        tr.composer,
        { timeout: 5000 },
      );
      check(
        await composer.evaluate((el) => el === document.activeElement),
        "Reply in chat focuses actual composer",
      );
      // Exercise the real RN-web ScrollView handler even when short content has
      // no scroll range. Its former on-drag mode blurred input on any scroll.
      await page
        .getByTestId("screen-scroll")
        .evaluate((el) => el.dispatchEvent(new Event("scroll")));
      await page.waitForTimeout(200);
      check(
        await composer.evaluate((el) => el === document.activeElement),
        "web chat scroll preserves reply composer focus",
      );
      const answer = `  Česká odpověď ${n} 👩‍💻\n`;
      check(
        answer.endsWith(String.fromCharCode(10)),
        "answer includes an actual newline",
      );
      await composer.fill(answer);
      if (name === "lost-answer" && n === 1)
        await page.evaluate(() =>
          window.niaroProcessQA.loseNext("process.answer"),
        );
      await button("send").click();
      if (name === "lost-answer" && n === 1) {
        await waitLoss("process.answer");
        await page
          .getByText("TEST question 2?", { exact: true })
          .first()
          .waitFor();
        const beforeReopen = await counts();
        await fixture.restart();
        await page.evaluate(() => window.niaroProcessQA.remount());
        await page.getByRole("tab", { name: tr.tasks, exact: true }).click();
        check(
          !(await page
            .getByText(setup.artifact.definition.name, { exact: true })
            .locator(":visible")
            .count()),
          "native process runs are not presented as human Tasks",
        );
        await page.getByRole("tab", { name: tr.chat, exact: true }).click();
        const detail = await openProcessRunHistory();
        await detail.waitFor();
        await page
          .getByText("TEST question 2?", { exact: true })
          .first()
          .waitFor();
        await capture("reopened-question");
        await button("replyInChat").first().click();
        reopenedPendingAnswer = true;
        equal(
          await page.evaluate(() => window.niaroProcessQA.pending()),
          [],
          "real answer history passively settles lost A after reopen",
        );
        equal(
          await counts(),
          beforeReopen,
          "answer-history reopen does not POST or dispatch",
        );
      }
    }
    if (writes === 0) {
      if (name === "lost-answer") {
        const deadline = Date.now() + 15_000;
        let completed;
        while (!completed) {
          const read = await fixture.loops();
          completed = read.data.entries.find(
            (entry) =>
              entry.process?.processId === setup.artifact.processId &&
              entry.status === "succeeded",
          );
          assert(
            Date.now() < deadline,
            "answered run did not settle to success",
          );
          if (!completed) await new Promise((done) => setTimeout(done, 50));
        }
        await openProcessRunHistory();
      }
      await finish();
      equal(
        await counts(),
        {
          model: questions + 1,
          service: 0,
          command: questions + 1,
          ordinary: 0,
        },
        "question flow uses exact process endpoint counts",
      );
    }
    for (let n = 1; n <= writes; n++) {
      await approval(n);
      equal(
        (await counts()).service,
        n - 1,
        "reviewing approval does not dispatch write",
      );
      if (name === "long-review") {
        check(
          (
            await page.getByTestId("service-action-parameters").innerText()
          ).includes("TEST parameter end"),
          "full long parameter is readable",
        );
        const tailVisible = await page
          .getByTestId("service-action-parameters")
          .evaluate(async (el) => {
            let scroll = el.parentElement;
            while (
              scroll &&
              !(
                scroll.scrollHeight > scroll.clientHeight + 1 &&
                /auto|scroll/.test(getComputedStyle(scroll).overflowY)
              )
            )
              scroll = scroll.parentElement;
            if (!scroll) return false;
            scroll.scrollIntoView({ block: "center", inline: "nearest" });
            scroll.scrollTop = scroll.scrollHeight;
            await new Promise((done) => requestAnimationFrame(done));
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
              const start = node.textContent.lastIndexOf("TEST parameter end");
              if (start < 0) continue;
              const range = document.createRange();
              range.setStart(node, start);
              range.setEnd(node, start + "TEST parameter end".length);
              const rect = range.getBoundingClientRect(),
                viewport = scroll.getBoundingClientRect(),
                screen = el
                  .closest('[data-testid="screen-scroll"]')
                  .getBoundingClientRect();
              return (
                rect.height > 0 &&
                rect.top >= Math.max(viewport.top, screen.top, 0) - 1 &&
                rect.bottom <=
                  Math.min(viewport.bottom, screen.bottom, innerHeight) + 1 &&
                rect.left >= Math.max(viewport.left, screen.left, 0) - 1 &&
                rect.right <=
                  Math.min(viewport.right, screen.right, innerWidth) + 1
              );
            }
            return false;
          });
        check(
          tailVisible,
          "actual nested parameter scroll makes final marker readable inside review, chat and browser viewports",
        );
        await capture("long-tail-" + n);
        await button("serviceApprove").scrollIntoViewIfNeeded();
        check(
          await button("serviceApprove").isVisible(),
          "approval control reachable after long review",
        );
        await capture("long-" + n);
      }
      if (n === 1 && name === "lost-approval")
        await page.evaluate(() =>
          window.niaroProcessQA.loseNext("service.resolve"),
        );
      if (n === 1 && name === "marker-offline")
        await page.evaluate(() => {
          window.niaroProcessQA.failSaving = true;
        });
      if (n === 1 && name === "cleanup-offline")
        await page.evaluate(() => {
          window.niaroProcessQA.failCleanup = true;
        });
      if (
        n === 2 &&
        ["deny", "lost-approval", "marker-offline", "cleanup-offline"].includes(
          name,
        )
      ) {
        await button("serviceReject").click();
        break;
      }
      await button("serviceApprove").click();
      if (
        n === 1 &&
        ["lost-approval", "marker-offline", "cleanup-offline"].includes(name)
      ) {
        await saved.waitFor();
        await approval(2);
        await saved
          .getByRole("button", {
            name: tr.savedProcessApprovalReview,
            exact: true,
          })
          .click();
        const savedParams = saved.getByTestId("service-action-parameters");
        check(
          (await savedParams.innerText()).includes("TEST write 1") &&
            !(await savedParams.innerText()).includes("TEST write 2"),
          "saved recovery displays original A parameters",
        );
        check(
          await button("serviceApprove").isDisabled(),
          "current B remains blocked while original A owns outbox",
        );
        const beforeRetry = await counts();
        if (name === "lost-approval") {
          await waitLoss("service.resolve");
          await waitEnabled(
            saved.getByRole("button", {
              name: tr.savedProcessApprovalRetrySame,
              exact: true,
            }),
          );
          await fixture.restart();
          await page.evaluate(() => window.niaroProcessQA.remount());
          await saved.waitFor();
          await saved
            .getByRole("button", {
              name: tr.savedProcessApprovalReview,
              exact: true,
            })
            .click();
          check(
            (
              await saved.getByTestId("service-action-parameters").innerText()
            ).includes("TEST write 1"),
            "AsyncStorage restores full original A review",
          );
          await capture("saved-original");
          await saved
            .getByRole("button", {
              name: tr.savedProcessApprovalRetrySame,
              exact: true,
            })
            .click();
          await saved.waitFor({ state: "hidden" });
          const commands = (await posts()).filter(
            (r) => JSON.parse(r.body).type === "service.resolve",
          );
          equal(
            commands[0].body,
            commands[1].body,
            "saved approval A retries exact original bytes while B is current",
          );
          equal(
            await counts(),
            { ...beforeRetry, command: beforeRetry.command + 1 },
            "original A retry cannot execute B",
          );
          await openProcessRunHistory();
        } else {
          await waitEnabled(
            saved.getByRole("button", {
              name: tr.processesRetrySaving,
              exact: true,
            }),
          );
          check(
            await page.evaluate(
              (kind) => window.niaroProcessQA.storageFailures.includes(kind),
              name === "marker-offline" ? "known-marker" : "known-cleanup",
            ),
            "actual known-outcome storage failure occurred before offline recovery",
          );
          await page.evaluate(() => {
            window.niaroProcessQA.offline = true;
            window.niaroProcessQA.failSaving = false;
            window.niaroProcessQA.failCleanup = false;
          });
          await saved
            .getByRole("button", { name: tr.processesRetrySaving, exact: true })
            .click();
          await saved.waitFor({ state: "hidden" });
          equal(
            await counts(),
            beforeRetry,
            "known offline retry is local saving without HTTP command/model/service dispatch",
          );
          equal(
            await page.evaluate(() => window.niaroProcessQA.pending()),
            [],
            "known outcome cleanup persisted",
          );
          await page.evaluate(() => {
            window.niaroProcessQA.offline = false;
            window.niaroProcessQA.remount();
          });
          await openProcessRunHistory();
        }
        await approval(2);
      }
    }
    if (
      [
        "service_failed",
        "service_unknown",
        "invalid_output",
        "deny",
        "lost-approval",
        "marker-offline",
        "cleanup-offline",
      ].includes(name)
    ) {
      await verifyTerminal();
      await capture("terminal");
    } else if (writes) {
      await finish();
      await capture("terminal");
    }
    const completeCounts = await counts();
    check(
      completeCounts.ordinary === 0,
      "process flow never calls ordinary command endpoint",
    );
    const commands = await posts();
    equal(
      JSON.parse(commands[0].body).input,
      { name: "  TEST browser typed input" },
      "start sends exactly the reviewed typed input",
    );
    const answers = commands.filter(
      (r) => JSON.parse(r.body).type === "process.answer",
    );
    equal(
      answers.map((r) => JSON.parse(r.body).answer),
      Array.from(
        { length: questions },
        (_, n) => `  Česká odpověď ${n + 1} 👩‍💻\n`,
      ),
      "actual composer sends exact whitespace and Unicode answers",
    );
    if (name === "happy")
      equal(
        completeCounts,
        { model: 5, service: 2, command: 5, ordinary: 0 },
        "complete native flow has exact counts",
      );
    await fixture.restart();
    await page.evaluate(() => window.niaroProcessQA.remount());
    await page.waitForFunction(() =>
      window.niaroProcessQA.snapshots.some((snapshot) =>
        snapshot.workItems.some((work) => work.process),
      ),
    );
    const journal = (await fixture.inspect()).processJournals.at(-1);
    const restored = await page.evaluate(() =>
      window.niaroProcessQA.snapshots.at(-1),
    );
    check(
      !!journal &&
        restored?.workItems.some(
          (work) =>
            work.process?.processId === journal.processId &&
            work.process.status === journal.status,
        ),
      "server restart/App remount passively restores the exact native process state",
    );
    equal(
      await counts(),
      completeCounts,
      "server restart/App remount/history open are passive",
    );
    const postsBeforeHistory = await posts();
    await openProcessRunHistory();
    if (name === "happy") await capture("reopened-history");
    if (
      [
        "service_failed",
        "service_unknown",
        "invalid_output",
        "deny",
        "lost-approval",
        "marker-offline",
        "cleanup-offline",
      ].includes(name)
    )
      await verifyTerminal();
    else await finish();
    equal(
      await posts(),
      postsBeforeHistory,
      "reopening a terminal run only reads history and output",
    );
    const noOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    );
    check(noOverflow, "mobile page has no horizontal overflow");
    results.cases.push({
      ...test,
      checks: results.checks - caseStart,
      counts: completeCounts,
    });
    console.log(`${label}: passed (${results.checks - caseStart} checks)`);
  } catch (error) {
    if (page) {
      writeFileSync(
        resolve(output, label + "-failure.txt"),
        await page.locator("body").innerText(),
      );
      writeFileSync(
        resolve(output, label + "-failure-focus.json"),
        JSON.stringify(
          await page.evaluate(() => ({
            active: document.activeElement?.outerHTML,
            events: window.niaroFocusQA,
          })),
          null,
          2,
        ),
      );
      await capture("failure");
      writeFileSync(
        resolve(output, label + "-failure-inspect.json"),
        JSON.stringify(
          {
            ...(await fixture.inspect()),
            clientSnapshots: await page.evaluate(
              () => window.niaroProcessQA.snapshots,
            ),
          },
          null,
          2,
        ),
      );
    }
    throw error;
  } finally {
    await context?.close();
    await fixture?.close();
    await new Promise((done) => server.close(done));
  }
}

try {
  for (const test of cases.filter(
    (c) =>
      !chosen ||
      chosen.includes(c.name) ||
      chosen.includes(`${c.name}-${c.width}-${c.language}`),
  ))
    await run(test);
  check(results.cases.length > 0, "at least one selected real App case ran");
  equal(
    fingerprint(),
    sourceBefore,
    "tested sources unchanged during rendered acceptance",
  );
  equal(results.external, 0, "no real external requests");
  equal(results.errors, [], "no app/browser errors");
  equal(results.warnings, [], "no app/browser warnings");
  results.passed = true;
} finally {
  await browser.close();
  writeFileSync(
    resolve(output, "source-before.json"),
    JSON.stringify(sourceBefore, null, 2),
  );
  writeFileSync(
    resolve(output, "source-after.json"),
    JSON.stringify(fingerprint(), null, 2),
  );
  writeFileSync(
    resolve(output, "results.json"),
    JSON.stringify(results, null, 2),
  );
  console.log("Evidence: " + output);
}
