import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { pipelineHttpChildFixture } from "../tests/helpers/process-pipeline-http-child.ts";
import { en, cs } from "../packages/i18n/index.ts";
import {
  designEn,
  designCs,
} from "../apps/server-admin/web/process-design-copy.ts";
import {
  consoleEn,
  consoleCs,
} from "../apps/server-admin/web/process-console-copy.ts";
import { ProcessVersionSchema } from "../packages/protocol/service-processes.ts";
import {
  PROCESS_VERSION_PROFILE,
  ProcessVersionListSchema,
} from "../packages/protocol/process-versions.ts";
import { NativeTestJobSchema } from "../packages/protocol/process-native-testing.ts";
import { ProcessActivationReceiptSchema } from "../packages/protocol/process-activation.ts";

// Optional externally installed Playwright; no dependency install or live calls.
const playwrightModule = process.env.NIARO_PLAYWRIGHT_MODULE;
const { chromium } = await import(
  playwrightModule
    ? pathToFileURL(resolve(playwrightModule)).href
    : "playwright"
);
const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceOwned = process.env.NIARO_PIPELINE_QA_OWNER === "workspace";
const output = process.env.NIARO_PIPELINE_QA_OUTPUT
  ? resolve(process.env.NIARO_PIPELINE_QA_OUTPUT)
  : mkdtempSync(resolve(tmpdir(), "niaro-pipeline-http-web-"));
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

// Fingerprint the bundled client and complete source roots for the real HTTP
// server and built administration. A prior UI-only hash is not backend QA.
const sourcePaths = new Set(
  Object.keys(bundled.metafile.inputs).filter(
    (p) => !p.includes("node_modules"),
  ),
);
function sources(relative) {
  for (const entry of readdirSync(resolve(cwd, relative), {
    withFileTypes: true,
  })) {
    const path = relative + "/" + entry.name;
    if (entry.name === "node_modules" || entry.name.startsWith("dist"))
      continue;
    if (entry.isDirectory()) sources(path);
    else if (/\.(tsx?|mjs|css)$/.test(path)) sourcePaths.add(path);
  }
}
for (const directory of [
  "apps/server-identity",
  "apps/server-agent",
  "apps/server-integrations",
  "apps/server-admin",
  "apps/reference-server",
  "apps/fixture-server",
  "packages/protocol",
  "tests/helpers",
])
  sources(directory);
sourcePaths.add("scripts/process-pipeline-web-qa.mjs");
const fingerprint = () =>
  Object.fromEntries(
    [...sourcePaths].sort().map((p) => [
      p,
      createHash("sha256")
        .update(readFileSync(resolve(cwd, p)))
        .digest("hex"),
    ]),
  );
const sourceBefore = fingerprint();
const results = {
  checks: 0,
  cases: [],
  captures: [],
  errors: [],
  warnings: [],
  httpErrors: [],
  expectedAnonymousOverview401: [],
  expectedDesignerAdmission404: [],
  browserDriverWarnings: [],
  external: 0,
  sourceFiles: sourcePaths.size,
  owner: workspaceOwned ? "workspace" : "service",
  physicalAndroid: false,
  liveAcceptance: false,
  fullBrowserReload: false,
  nativeAudioAndSSO: false,
};
const responseBodies = [];
const check = (condition, message) => {
  results.checks++;
  assert(condition, message);
};
const equal = (value, expected, message) => {
  results.checks++;
  assert.deepEqual(value, expected, message);
};
const browser = await chromium.launch({ headless: true });
const chosen = process.env.NIARO_PIPELINE_QA_CASES?.split(",");
const cases = [
  { name: "success", language: "en", width: 1440 },
  { name: "success", language: "cs", width: 360 },
  { name: "denial", language: "cs", width: 320 },
  { name: "denial", language: "en", width: 1440 },
  { name: "unknown", language: "en", width: 390 },
  { name: "unknown", language: "cs", width: 1440 },
  { name: "failure", language: "cs", width: 390 },
  { name: "failure", language: "en", width: 1440 },
].filter((test) => !chosen || chosen.includes(test.name + "-" + test.language));

async function run(test) {
  const { name, language, width } = test;
  const label = name + "-" + language + "-" + width;
  const copy = language === "cs" ? designCs : designEn;
  const consoleCopy = language === "cs" ? consoleCs : consoleEn;
  const tr = language === "cs" ? cs : en;
  const beforeChecks = results.checks;
  let fixture, context, page, bootstrap;
  let loggedIn = false;
  let inspectOutput;
  const preview = createServer((req, res) => {
    if (req.url === "/bootstrap") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(bootstrap));
    } else if (req.url === "/app.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(readFileSync(resolve(output, "app.js")));
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0;font-family:Arial;background:#eef2f7}#root{display:flex;min-width:0}*{box-sizing:border-box}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
      );
    }
  });
  await new Promise((done) => preview.listen(0, "127.0.0.1", done));
  const origin = "http://127.0.0.1:" + preview.address().port;
  const capture = async (suffix) => {
    const path = resolve(output, label + "-" + suffix + ".png");
    await page.screenshot({ path, fullPage: true });
    results.captures.push(path);
  };
  try {
    fixture = await pipelineHttpChildFixture({
      cwd,
      testAllowedOrigins: [origin],
      outputPadding: true,
      workspaceOwned,
    });
    const setup = await fixture.setupOnly();
    equal(
      (await fixture.inspect()).processes,
      [],
      "setup has no process or activation",
    );
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
    await context.addInitScript((value) => {
      localStorage.setItem("agent-admin-language", value);
    }, language);
    page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on("response", (response) => {
      if (response.status() >= 400) {
        const record = {
          case: label,
          status: response.status(),
          method: response.request().method(),
          url: response.url(),
        };
        results.httpErrors.push(record);
        responseBodies.push(
          response
            .json()
            .then((body) => {
              record.code = body.error;
            })
            .catch(() => {}),
        );
      }
    });
    page.on("pageerror", (error) =>
      results.errors.push({ case: label, error: String(error) }),
    );
    page.on("console", (message) => {
      if (message.type() === "error") {
        if (
          !loggedIn &&
          message.text() ===
            "Failed to load resource: the server responded with a status of 401 (Unauthorized)"
        )
          results.expectedAnonymousOverview401.push({
            case: label,
            message: message.text(),
          });
        else
          results.errors.push({
            case: label,
            error: message.text(),
            url: message.location().url,
          });
      }
      if (message.type() === "warning") {
        // Screenshot capture can emit Chromium's ReadPixels driver warning;
        // retain it as runtime evidence rather than an application warning.
        const warning = { case: label, warning: message.text() };
        if (message.text().includes("GPU stall due to ReadPixels"))
          results.browserDriverWarnings.push(warning);
        else results.warnings.push(warning);
      }
    });
    await page.goto(
      fixture.origin +
        (workspaceOwned ? "/admin/processes" : "/admin/services"),
    );
    await page.locator("#admin-email").fill(setup.admin.email);
    await page.locator("#admin-key").fill(setup.admin.password);
    await page
      .getByRole("button", {
        name: language === "cs" ? "Přihlásit" : "Sign in",
        exact: true,
      })
      .click();
    if (workspaceOwned)
      await page
        .getByRole("link", {
          name: language === "cs" ? "Navrhnout proces" : "Design a process",
          exact: true,
        })
        .waitFor();
    else
      await page
        .getByText("TEST CRM contacts", { exact: true })
        .first()
        .waitFor();
    loggedIn = true;
    if (workspaceOwned) {
      await capture("workspace-processes");
      await page
        .getByRole("link", {
          name: language === "cs" ? "Navrhnout proces" : "Design a process",
          exact: true,
        })
        .click();
    } else {
      await page
        .getByText("TEST CRM contacts", { exact: true })
        .first()
        .click();
      await page
        .getByRole("tab", { name: copy.processes, exact: true })
        .click();
      await page.getByRole("link", { name: copy.add, exact: true }).click();
    }
    await page
      .getByRole("button", { name: copy.designWithAgent, exact: true })
      .click();
    await page.locator("#design-model").click();
    await page.getByRole("option", { name: /TEST tools model/ }).click();
    await page.locator("#design-message").fill(setup.brief.purpose);
    await page.getByRole("button", { name: copy.send, exact: true }).click();
    await page.waitForURL((url) => url.searchParams.has("sessionId"));
    await page.getByRole("tab", { name: copy.review, exact: true }).click();
    await page
      .getByRole("button", { name: copy.acknowledge, exact: true })
      .waitFor();
    for (const box of await page.locator('[id^="assumption-"]').all())
      await box.check();
    await page
      .getByRole("button", { name: copy.acknowledge, exact: true })
      .click();
    await page.getByRole("button", { name: copy.save, exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: copy.save, exact: true })
      .click();
    await page
      .getByRole("link", { name: copy.testsVersions, exact: true })
      .click();
    const authored = await fixture.inspect();
    equal(
      authored.processes.length,
      1,
      "native designer saved exactly one real process draft",
    );
    equal(
      authored.processes[0].activeVersion,
      null,
      "accepting a proposal does not activate",
    );
    check(
      authored.requests.some(
        (r) => r.path.includes("/design/acknowledge") && r.status === 200,
      ),
      "human acknowledged concrete design assumptions",
    );
    check(
      !authored.requests.some((r) => r.body?.includes('"type":"saveDraft"')),
      "draft came from designer acceptance, not a hidden registry save",
    );
    equal(
      authored.serviceDispatches,
      [],
      "designer performed no business calls",
    );
    if (workspaceOwned) await page.reload();
    await page
      .getByRole("button", { name: consoleCopy.freeze, exact: true })
      .click();
    const freezeResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith("/catalog/processes/versions/freeze") &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: consoleCopy.freeze, exact: true })
      .click();
    const frozenResponse = await freezeResponse;
    equal(frozenResponse.status(), 200, "actual console freeze HTTP accepted");
    const frozenData = await frozenResponse.json();
    const versionHistory = await context.request.get(
      fixture.origin +
        "/admin/api/identity/catalog/processes/versions?" +
        new URLSearchParams({
          ...setup.target,
          profile: PROCESS_VERSION_PROFILE,
          processId: authored.processes[0].id,
        }),
      { headers: { "X-Agent-Admin": "1", Origin: fixture.origin } },
    );
    equal(
      versionHistory.status(),
      200,
      "real authenticated immutable version read succeeds",
    );
    const artifact = ProcessVersionSchema.parse(
      ProcessVersionListSchema.parse(await versionHistory.json()).versions.find(
        (v) => v.version === frozenData.receipt.version,
      ),
    );
    equal(
      artifact.digest,
      frozenData.receipt.artifactDigest,
      "immutable version matches actual freeze receipt",
    );
    await page
      .getByRole("tab", { name: consoleCopy.tests, exact: true })
      .click();
    await page
      .getByRole("button", { name: consoleCopy.import, exact: true })
      .click();
    await page
      .locator("#process-suite-import")
      .fill(JSON.stringify(await fixture.qualificationSuite(), null, 2));
    await page
      .getByRole("button", { name: consoleCopy.apply, exact: true })
      .click();
    await page
      .getByRole("button", { name: consoleCopy.run, exact: true })
      .click();
    const testResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith("/catalog/processes/tests/native") &&
        r.request().method() === "POST",
      { timeout: 150000 },
    );
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: consoleCopy.run, exact: true })
      .click();
    const tested = await testResponse;
    equal(tested.status(), 200, "actual isolated test HTTP accepted");
    const job = NativeTestJobSchema.parse((await tested.json()).job);
    writeFileSync(
      resolve(output, label + "-native-test-job.json"),
      JSON.stringify(job, null, 2),
    );
    equal(
      job.qualification.status,
      "qualified",
      "all six configured/generic families qualify actual saved workflow",
    );
    equal(
      job.report.observations.length,
      12,
      "qualification observes twelve native strategy executions",
    );
    check(
      job.report.observations.every((item) => item.passed),
      "every required observation passed",
    );
    equal(
      artifact.digest,
      job.stamp.artifactDigest,
      "test binds exact UI-frozen artifact",
    );
    await capture("qualified");
    await page
      .getByRole("button", { name: consoleCopy.activate, exact: true })
      .click();
    const dialog = page.getByRole("alertdialog");
    check(
      !(await dialog
        .getByRole("button", { name: consoleCopy.activate, exact: true })
        .isEnabled()),
      "activation requires separate explicit acknowledgement",
    );
    await page.locator("#process-ack").check();
    const activationResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith("/catalog/processes/activation") &&
        r.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: consoleCopy.activate, exact: true })
      .click();
    const activated = await activationResponse;
    equal(activated.status(), 200, "real human activation HTTP succeeds");
    const receipt = ProcessActivationReceiptSchema.parse(
      (await activated.json()).receipt,
    );
    equal(
      receipt.testId,
      job.testId,
      "activation binds exact observed native test",
    );
    equal(
      receipt.qualificationDigest,
      job.qualification.qualificationDigest,
      "activation binds exact qualification",
    );
    equal(
      receipt.artifactDigest,
      artifact.digest,
      "activation binds exact artifact",
    );
    equal(
      receipt.acknowledgement,
      "controlled_native_test_only",
      "live quality is not claimed by activation",
    );
    const beforeMobile = await fixture.inspect();
    equal(
      beforeMobile.serviceDispatches,
      [],
      "qualification and activation perform no live service action",
    );
    await fixture.runtimeScenario(
      ["failure", "unknown"].includes(name) ? name : "success",
    );
    bootstrap = {
      origin: fixture.origin,
      artifact,
      pairing: await fixture.issuePairing(),
    };
    await page.goto(origin + "/?lang=" + language);
    await page.waitForFunction(
      () => window.niaroProcessQA?.ready || document.body.dataset.failed,
    );
    check(
      !(await page.locator("body").getAttribute("data-failed")),
      "real App/Connections pairing bootstrap completed",
    );
    const button = (key) =>
      page.getByRole("button", { name: tr[key], exact: true });
    const openTasks = async () => {
      await page.getByRole("tab", { name: tr.tasks, exact: true }).click();
    };
    const openProcessHistory = async () => {
      await page.getByRole("tab", { name: tr.chat, exact: true }).click();
      await button("menu").click();
      await button("processesTitle").click();
      const panel = page.getByTestId("process-launch-panel");
      await panel.getByText(tr.processRunHistory, { exact: true }).waitFor();
      await panel
        .getByRole("button", { name: new RegExp(artifact.definition.name) })
        .click();
      const detail = page.getByTestId("process-run-history-detail");
      await detail.waitFor();
      await detail.getByText(terminal, { exact: true }).first().waitFor();
    };
    const closeProcessHistory = async () => {
      const panel = page.getByTestId("process-launch-panel");
      await panel.getByRole("button", { name: tr.back, exact: true }).click();
      await panel.getByRole("button", { name: tr.close, exact: true }).click();
    };
    await button("menu").click();
    await button("processesTitle").click();
    await button("processesLoad").click();
    await page
      .getByRole("radio", {
        name: tr.processesSelect + ": " + artifact.definition.name,
        exact: true,
      })
      .click();
    await button("processesPrepare").click();
    await page.getByTestId("process-input-card").waitFor();
    for (const [key, value] of Object.entries(setup.input))
      await page.getByRole("textbox", { name: key, exact: true }).fill(value);
    await page
      .getByTestId("process-input-card")
      .getByRole("button")
      .last()
      .click();
    await page.getByTestId("process-launch-review").waitFor();
    await page
      .getByTestId("process-launch-review")
      .getByRole("button", { name: tr.processesDetails, exact: true })
      .click();
    for (const value of Object.values(setup.input))
      check(
        (await page.getByTestId("process-launch-input").innerText()).includes(
          value,
        ),
        "launch review shows concrete field " + value,
      );
    equal(
      (await fixture.inspect()).serviceDispatches,
      [],
      "mobile form and review are passive",
    );
    await button("processesStart").click();
    await page.getByText(tr.processesAccepted, { exact: true }).waitFor();
    await button("close").click();
    await page.getByText(setup.question, { exact: true }).first().waitFor();
    equal(
      (await fixture.inspect()).serviceDispatches.length,
      1,
      "CRM lookup precedes ambiguity question",
    );
    await button("replyInChat").first().click();
    const composer = page.getByRole("textbox", {
      name: tr.composer,
      exact: true,
    });
    await composer.fill(setup.answer);
    await button("send").click();
    const parameters = page.getByTestId("service-action-parameters");
    await parameters.waitFor();
    for (const value of Object.values(setup.input))
      check(
        (await parameters.innerText()).includes(value),
        "approval shows exact meeting field " + value,
      );
    equal(
      (await fixture.inspect()).serviceDispatches.filter(
        (d) => d.method === "POST",
      ),
      [],
      "review has no meeting write before consent",
    );
    await capture("approval");
    await button(
      name === "denial" ? "serviceReject" : "serviceApprove",
    ).click();
    const terminal =
      name === "success"
        ? tr.nativeSucceeded
        : name === "denial"
          ? tr.cancelled
          : name === "unknown"
            ? tr.processUnknown
            : tr.failed;
    await page.getByText(terminal, { exact: true }).first().waitFor();
    const assertProcessAnnouncement = async (surface) => {
      const announcement = page.getByTestId("process-command-notice");
      if (name === "success") {
        equal(
          await announcement.count(),
          0,
          surface + " has no false failure announcement",
        );
        return;
      }
      const key =
        name === "denial"
          ? "processDecisionDeclined"
          : name === "unknown"
            ? "processResultUnknown"
            : "processResultFailed";
      await announcement.getByText(tr[key], { exact: true }).waitFor();
      equal(
        await announcement.count(),
        1,
        surface + " has one owned process announcement",
      );
      equal(
        await page.getByText(tr.requestRejected, { exact: true }).count(),
        0,
        surface + " does not invent a configuration cause",
      );
      equal(
        await announcement.locator('[aria-live="polite"]').count(),
        1,
        surface + " announces its exact outcome accessibly",
      );
      equal(
        await announcement.getByRole("alert").count(),
        name === "failure" ? 1 : 0,
        surface + " distinguishes failure from a decline or unconfirmed result",
      );
      equal(
        await button("retry").count(),
        0,
        surface + " announcement grants no new retry control",
      );
      const header = page.getByTestId("screen-header");
      const bounds = await header.boundingBox();
      check(
        !!bounds && bounds.x >= -1 && bounds.x + bounds.width <= width + 1,
        surface + " header fits the viewport",
      );
      // Tasks stays one tap away in the tab bar on every screen.
      check(
        await page
          .getByRole("tab", { name: tr.tasks, exact: true })
          .isEnabled(),
        surface + " Tasks remains available",
      );
    };
    await assertProcessAnnouncement("Chat");
    const after = await fixture.inspect();
    equal(
      after.serviceDispatches.filter((d) => d.method === "POST").length,
      ["success", "unknown"].includes(name) ? 1 : 0,
      "canonical write count matches actual dispatch boundary",
    );
    equal(
      after.serviceDispatches.filter((d) => d.path.endsWith("/readback"))
        .length,
      name === "success" ? 1 : 0,
      "readback only follows known successful meeting write",
    );
    const commands = await page.evaluate(() =>
      window.niaroProcessQA.requests.filter(
        (r) =>
          r.method === "POST" &&
          r.path.split("?")[0].endsWith("/processes/commands"),
      ),
    );
    equal(
      commands.map((r) => JSON.parse(r.body).type),
      ["process.start", "process.answer", "service.resolve"],
      "App uses only three explicit process commands",
    );
    equal(
      JSON.parse(commands[1].body).answer,
      setup.answer,
      "exact answer bytes including whitespace and newline reach HTTP",
    );
    equal(
      JSON.parse(commands[2].body).approved,
      name !== "denial",
      "explicit human decision reaches HTTP",
    );
    equal(
      after.modelCalls - beforeMobile.modelCalls,
      2,
      "specialized agent uses exactly two actual model calls",
    );
    const loops = await fixture.loops();
    equal(loops.status, 200, "authenticated Loops can read native pipeline");
    check(
      loops.data.entries.some(
        (item) => item.process?.processId === artifact.processId,
      ),
      "Loops binds same process as design/test/activation/App",
    );
    const actionCount = name === "success" ? 4 : 3;
    const actionLabel =
      language === "cs"
        ? `Uložené akce (${actionCount})`
        : `Recorded actions (${actionCount})`;
    await page.getByRole("button", { name: actionLabel, exact: true }).click();
    if (name === "success") {
      const outputButton = page.getByRole("button", {
        name: tr.processOutputTitle,
        exact: true,
      });
      await outputButton.click();
      equal(
        await outputButton.getAttribute("aria-expanded"),
        "true",
        "output disclosure is actually expanded",
      );
      await page
        .getByText(
          tr.processOutputPreview
            .replace("{shown}", "8")
            .replace("{total}", "23"),
          { exact: true },
        )
        .waitFor();
      check(
        true,
        "the eight-field card is explicitly a preview of twenty-three fields",
      );
      inspectOutput = async (owner) => {
        await page
          .getByRole("button", { name: tr.processOutputOpen, exact: true })
          .click();
        const sheet = page.getByTestId("detail-sheet").last();
        await page.getByTestId("process-output-page").waitFor();
        const fields = [];
        let pageCount = 0;
        while (true) {
          check(pageCount < 100, "output pagination remains bounded");
          const output = page.getByTestId("process-output-page");
          for (const field of Object.keys(setup.expectedResult)) {
            if (
              await output
                .getByRole("button", {
                  name: tr.processOutputOpenField.replace("{label}", field),
                  exact: true,
                })
                .count()
            )
              fields.push(field);
          }
          pageCount++;
          const next = output.getByRole("button", {
            name: tr.processOutputNext,
            exact: true,
          });
          if (!(await next.count())) break;
          await next.click();
          await page
            .getByText(tr.processOutputLoading, { exact: true })
            .waitFor({ state: "hidden" });
          await output.waitFor();
        }
        equal(
          fields.sort(),
          Object.keys(setup.expectedResult).sort(),
          owner + " exposes every output field across complete pages",
        );
        equal(
          pageCount,
          2,
          owner + " traverses the actual bounded two-page output",
        );
        for (const [field, value] of [
          ["meetingId", setup.expectedResult.meetingId],
          ["confirmed", "true"],
        ]) {
          const fieldButton = page.getByRole("button", {
            name: tr.processOutputOpenField.replace("{label}", field),
            exact: true,
          });
          if (!(await fieldButton.count())) {
            await page
              .getByRole("button", {
                name: tr.processOutputPrevious,
                exact: true,
              })
              .click();
            await fieldButton.waitFor();
          }
          await page
            .getByRole("button", {
              name: tr.processOutputOpenField.replace("{label}", field),
              exact: true,
            })
            .click();
          await page.getByTestId("process-output-value").waitFor();
          equal(
            await page.getByTestId("process-output-value").textContent(),
            value,
            owner + " shows the exact full scalar " + field,
          );
          await sheet
            .getByRole("button", { name: tr.processOutputRoot, exact: true })
            .click();
          await page.getByTestId("process-output-page").waitFor();
        }
        const previous = page.getByRole("button", {
          name: tr.processOutputPrevious,
          exact: true,
        });
        if (await previous.count()) await previous.click();
        await page.getByTestId("process-output-page").waitFor();
        await page
          .getByRole("button", {
            name: tr.processOutputOpenField.replace("{label}", "audit00"),
            exact: true,
          })
          .click();
        await page.getByTestId("process-output-value").waitFor();
        equal(
          await page.getByTestId("process-output-value").textContent(),
          setup.expectedResult.audit00,
          owner + " reads the entire 4000-character leaf",
        );
        const scroll = await sheet.evaluate((element) => {
          const scrollable = [...element.querySelectorAll("div")].find(
            (node) =>
              /auto|scroll/.test(getComputedStyle(node).overflowY) &&
              node.scrollHeight > node.clientHeight,
          );
          if (!scrollable) return { scrollable: false };
          scrollable.scrollTop = scrollable.scrollHeight;
          return {
            scrollable: true,
            atEnd:
              scrollable.scrollTop + scrollable.clientHeight >=
              scrollable.scrollHeight - 2,
            height: element.getBoundingClientRect().height,
            viewport: innerHeight,
          };
        });
        check(
          scroll.scrollable && scroll.atEnd && scroll.height <= scroll.viewport,
          owner + " has a bounded sheet and actually scrolls to the end",
        );
        await capture("output-" + owner);
        await sheet
          .getByRole("button", { name: tr.close, exact: true })
          .click();
        await page
          .getByTestId("process-output-page")
          .waitFor({ state: "hidden" });
        check(
          await page
            .getByRole("button", { name: tr.processOutputOpen, exact: true })
            .isVisible(),
          owner + " closes and restores its card control",
        );
      };
      await inspectOutput("chat");
      check(
        after.receipts.some(
          (r) =>
            r.status === "succeeded" &&
            r.actionId === setup.actionIds.readback &&
            r.result?.meetingId === setup.expectedResult.meetingId,
        ),
        "canonical readback retains actual meeting identity beyond bounded card fields",
      );
    }
    await capture("result");
    await openTasks();
    await assertProcessAnnouncement("Tasks");
    equal(
      await page
        .getByRole("button", { name: new RegExp(artifact.definition.name) })
        .count(),
      0,
      "human Tasks does not contain process history jobs",
    );
    await capture("tasks-announcement");
    await openProcessHistory();
    await capture("process-history");
    await closeProcessHistory();
    await assertProcessAnnouncement("Chat after reading process history");
    const counts = {
      model: after.modelCalls,
      dispatch: after.serviceDispatches.length,
    };
    await fixture.restart();
    await page.evaluate(() => window.niaroProcessQA.remount());
    await openProcessHistory();
    const reopened = await fixture.inspect();
    equal(
      {
        model: reopened.modelCalls,
        dispatch: reopened.serviceDispatches.length,
      },
      counts,
      "passive server reopen and same-JS App remount cause no inference/effect",
    );
    if (name === "success") {
      await inspectOutput("process-history-reopen-1");
      await fixture.restart();
      await page.evaluate(() => window.niaroProcessQA.remount());
      await openProcessHistory();
      await inspectOutput("process-history-reopen-2");
      const readOnly = await fixture.inspect();
      equal(
        {
          model: readOnly.modelCalls,
          dispatch: readOnly.serviceDispatches.length,
        },
        counts,
        "two reopened owner reads add no model, CRM, or Calendar dispatch",
      );
      const outputReads = await page.evaluate(() =>
        window.niaroProcessQA.requests.filter((r) =>
          r.path.split("?")[0].endsWith("/processes/output"),
        ),
      );
      check(
        outputReads.length > 0 &&
          outputReads.every((r) => r.method === "GET" && r.status === 200),
        "actual paired Session uses only successful passive output GETs",
      );
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    );
    check(!overflow, "mobile viewport has no horizontal overflow");
    results.cases.push({
      ...test,
      checks: results.checks - beforeChecks,
      processId: artifact.processId,
      artifactDigest: artifact.digest,
      testId: job.testId,
      qualificationDigest: receipt.qualificationDigest,
    });
  } catch (error) {
    if (page) await capture("failed").catch(() => {});
    throw error;
  } finally {
    await context?.close();
    await fixture?.close();
    await new Promise((done) => preview.close(done));
  }
}
try {
  for (const test of cases) {
    await run(test);
    process.stdout.write("PASS " + test.name + " " + test.language + "\n");
  }
  await Promise.all(responseBodies);
  results.errors = results.errors.filter((error) => {
    if (
      error.error !==
      "Failed to load resource: the server responded with a status of 404 (Not Found)"
    )
      return true;
    const failures = results.httpErrors.filter(
      (record) => record.case === error.case && record.status === 404,
    );
    const expected = failures.find((record) => {
      const url = new URL(record.url);
      return (
        record.method === "GET" &&
        record.code === "process_design_turn_not_found" &&
        url.pathname === "/admin/api/identity/catalog/processes/design/turns" &&
        url.searchParams.has("sessionId") &&
        url.searchParams.has("requestId") &&
        (error.url === record.url || (!error.url && failures.length === 1))
      );
    });
    if (!expected) return true;
    // The client's passive exact-reader probe may precede admission of its
    // queued first turn; only this verified protocol absence is expected.
    results.expectedDesignerAdmission404.push(expected);
    return false;
  });
  equal(
    fingerprint(),
    sourceBefore,
    "all client/admin/backend sources remained stable throughout rendered QA",
  );
  equal(results.external, 0, "no external browser request");
  equal(results.errors, [], "no browser errors");
  equal(results.warnings, [], "no browser warnings");
  results.sourceUnchanged = true;
} finally {
  writeFileSync(
    resolve(output, "results.json"),
    JSON.stringify(
      { ...results, sourceBefore, sourceAfter: fingerprint() },
      null,
      2,
    ),
  );
  await browser.close();
}
