// Browser plugin not available in the task; use the existing bundled Playwright runtime.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
const module = process.env.NIARO_PLAYWRIGHT_MODULE;
const { chromium } = await import(
  module ? pathToFileURL(resolve(module)).href : "playwright"
);
const output =
  process.env.NIARO_MEETING_QA_OUTPUT ??
  mkdtempSync(join(tmpdir(), "niaro-meetings-web-"));
await build({
  entryPoints: ["tests/helpers/meeting-web-app.tsx"],
  bundle: true,
  format: "iife",
  platform: "browser",
  outfile: join(output, "app.js"),
  alias: {
    "react-native": "react-native-web",
    "react-native-svg": resolve(
      "node_modules/react-native-svg/lib/module/ReactNativeSVG.web.js",
    ),
  },
  resolveExtensions: [".web.tsx", ".web.ts", ".web.js", ".tsx", ".ts", ".js"],
});
const server = createServer((req, res) => {
  if (req.url === "/app.js") {
    res.setHeader("Content-Type", "application/javascript");
    res.end(readFileSync(join(output, "app.js")));
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.end(
    '<!doctype html><html><head><title>Niaro meetings QA</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root"></div><script src="/app.js"></script></body></html>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const url = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 393, height: 852 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url);
  assert.equal(await page.title(), "Niaro meetings QA");
  assert.equal(new URL(page.url()).origin, url);
  await page.getByText("Meetings QA", { exact: true }).waitFor();
  await page
    .getByTestId("meeting-11111111-1111-4111-8111-111111111111")
    .click();
  await page.getByText("Tasks · 1", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Quote 0:00", exact: true })
    .click();
  await page.getByText("Source selected 0:00", { exact: true }).waitFor();
  await page.screenshot({
    path: join(output, "meeting-mobile-en.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Česky", exact: true }).click();
  await page.getByText("Úkoly · 1", { exact: true }).waitFor();
  await page.screenshot({
    path: join(output, "meeting-mobile-cs.png"),
    fullPage: true,
  });
  await page
    .getByTestId("human-task-TEST-human-task")
    .screenshot({ path: join(output, "human-open-cs.png") });
  await page
    .getByRole("button", { name: "Řešit s asistentem", exact: true })
    .click();
  await page.getByText("Resolve requested", { exact: true }).waitFor();
  await page
    .getByRole("button", {
      name: "Otevřít úkol: Arrange the follow-up meeting with Anna",
      exact: true,
    })
    .click();
  await page.getByText("Hotovo", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Řešit s asistentem", exact: true })
      .count(),
    0,
  );
  await page
    .getByTestId("human-task-TEST-human-task")
    .screenshot({ path: join(output, "human-done-cs.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: join(output, "meeting-desktop.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  writeFileSync(
    join(output, "report.json"),
    JSON.stringify(
      {
        page: url,
        title: await page.title(),
        browserPath: "Browser plugin not available",
        blank: false,
        frameworkOverlay: false,
        consoleErrors: errors,
        checks: [
          "open record",
          "source excerpt",
          "Czech locale",
          "mobile and desktop",
          "open item resolve action",
          "open item marked done",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ output, checks: 6, consoleErrors: errors.length }),
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
