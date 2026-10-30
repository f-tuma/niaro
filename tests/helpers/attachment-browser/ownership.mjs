/** Actual web adapter regression runner; use an owned synthetic harness and existing Playwright installation. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const { chromium } = await import(
  process.env.ATTACHMENT_PLAYWRIGHT_MODULE ?? "playwright"
);
const base = process.env.ATTACHMENT_QA_URL ?? "http://127.0.0.1:8891/";
assert.equal(new URL(base).hostname, "127.0.0.1");
const out = resolve(
  process.env.ATTACHMENT_QA_OUTPUT ?? "/tmp/niaro-attachment-ownership",
);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.ATTACHMENT_CHROMIUM,
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
});
const page = await context.newPage();
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
async function ready() {
  await page.goto(base);
  await page.getByRole("textbox").fill("TEST preserved caption");
}
async function syntheticCamera(deferred = false) {
  await page.evaluate((deferred) => {
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", {
      configurable: true,
      get: () => 96,
    });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", {
      configurable: true,
      get: () => 64,
    });
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (image, ...args) {
      if (image instanceof HTMLVideoElement) this.fillRect(0, 0, 96, 64);
      else draw.call(this, image, ...args);
    };
    window.trackStops = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 96;
      canvas.height = 64;
      canvas.getContext("2d").fillRect(0, 0, 96, 64);
      const stream = canvas.captureStream(5);
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          window.trackStops++;
          stop();
        };
      }
      if (deferred)
        await new Promise((resolve) => {
          window.releasePermission = resolve;
        });
      return stream;
    };
  }, deferred);
}
async function openCamera(wait = true) {
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await page.getByRole("menuitem", { name: "Camera", exact: true }).click();
  if (wait) await page.locator("video").waitFor();
}
async function closeCamera() {
  await page
    .getByRole("button", { name: "Close", exact: true })
    .first()
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
}
async function delayedEncoding() {
  await page.evaluate(() => {
    const encode = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      window.releaseEncoding = () => encode.call(this, callback, ...args);
    };
  });
  await page.getByRole("button", { name: "Use photo", exact: true }).click();
  await page.waitForFunction(
    () => typeof window.releaseEncoding === "function",
  );
}
async function assertNoLateSelection() {
  await page.evaluate(() => window.releaseEncoding());
  // Cross the real encode/bitmap decode completion boundary before asserting absence.
  await page.waitForTimeout(150);
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(
    await page.evaluate(
      () =>
        window.niaroAttachmentClient.attachments.getSnapshot().entries.length,
    ),
    0,
  );
  assert(await page.evaluate(() => window.trackStops > 0));
}
try {
  await ready();
  await syntheticCamera();
  await openCamera();
  await closeCamera();
  assert.equal(
    await page.evaluate(() => document.activeElement?.tagName),
    "TEXTAREA",
  );
  assert.equal(
    await page.getByRole("textbox").inputValue(),
    "TEST preserved caption",
  );
  checks.push(
    "ordinary Camera Close returns composer focus and preserves caption",
  );

  await openCamera();
  await delayedEncoding();
  await closeCamera();
  await assertNoLateSelection();
  checks.push(
    "Close invalidates delayed real canvas encoding and stops tracks",
  );

  await ready();
  await syntheticCamera();
  await openCamera();
  await delayedEncoding();
  await page.evaluate(() =>
    window.niaroAttachmentSelectConversation("TEST-other-chat"),
  );
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("textbox").focus();
  await assertNoLateSelection();
  assert.equal(
    await page.evaluate(() => document.activeElement?.tagName),
    "TEXTAREA",
  );
  checks.push(
    "conversation scope exit invalidates delayed encoding and preserves the new composer focus",
  );

  await ready();
  await syntheticCamera(true);
  await openCamera(false);
  await page.waitForFunction(
    () => typeof window.releasePermission === "function",
  );
  await page.evaluate(() =>
    window.niaroAttachmentSelectConversation("TEST-other-chat"),
  );
  await page.evaluate(() => window.releasePermission());
  await page.waitForTimeout(100);
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert(await page.evaluate(() => window.trackStops > 0));
  checks.push(
    "late permission completion after scope exit stops stream without opening camera",
  );

  await ready();
  await syntheticCamera();
  await openCamera();
  await page.getByRole("button", { name: "Use photo", exact: true }).click();
  await page.getByRole("button", { name: "Retake", exact: true }).waitFor();
  await page.getByRole("button", { name: "Retake", exact: true }).click();
  await page.locator("video").waitFor();
  await closeCamera();
  assert.equal(
    await page.evaluate(() => document.activeElement?.tagName),
    "TEXTAREA",
  );
  checks.push(
    "Retake transfers to a fresh camera owner and Close returns focus",
  );

  const fixture = resolve(out, "TEST.txt");
  await writeFile(fixture, "TEST retained layout fixture");
  await ready();
  await page.getByRole("textbox").fill("");
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await (await chooser).setFiles(fixture);
  await page.getByText("Uploaded", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByText("Processing unavailable", { exact: true })
    .last()
    .waitFor();
  const layout = [];
  for (const [language, width, large] of [
    ["cs", 320, true],
    ["en", 520, false],
    ["cs", 1280, false],
  ]) {
    await page.setViewportSize({ width, height: 844 });
    const url = new URL(base);
    url.searchParams.set("lang", language);
    if (large) url.searchParams.set("large", "1");
    await page.goto(url.href);
    const label =
      language === "cs" ? "Zpracování není dostupné" : "Processing unavailable";
    await page.getByText(label, { exact: true }).first().waitFor();
    const bounds = await page.evaluate(
      (label) =>
        Array.from(document.querySelectorAll("article *"))
          .filter(
            (element) =>
              element.textContent === label && element.tagName === "P",
          )
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, width: rect.width };
          }),
      label,
    );
    assert(bounds.length > 0);
    for (const rect of bounds) {
      assert(rect.left >= 0, JSON.stringify(rect));
      assert(rect.right <= width, JSON.stringify(rect));
    }
    const downloads = await page
      .getByRole("button", { name: /Download|Stáhnout/ })
      .all();
    for (const download of downloads) {
      const rect = await download.boundingBox();
      assert(rect && rect.x >= 0 && rect.x + rect.width <= width);
    }
    layout.push({ language, width, large, bounds });
    await page.screenshot({
      path: resolve(
        out,
        `${language}-${width}-${large ? "large" : "normal"}.png`,
      ),
    });
  }
  checks.push(
    "retained processing labels and original-download controls stay within both viewport edges",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(out, "ownership.json"),
    JSON.stringify(
      {
        browser: await browser.version(),
        base,
        synthetic:
          "canvas MediaStream/video frame with real canvas encoding; no hardware camera claim",
        checks,
        layout,
        errors,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ checks, layout, errors }, null, 2));
} finally {
  await browser.close();
}
