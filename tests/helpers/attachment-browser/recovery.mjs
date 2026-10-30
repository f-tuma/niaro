/** Real composer Edit/Again recovery against an isolated owned HTTP fixture. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const { chromium } = await import(
  process.env.ATTACHMENT_PLAYWRIGHT_MODULE ?? "playwright"
);
const base = process.env.ATTACHMENT_QA_URL ?? "http://127.0.0.1:8892/";
assert.equal(new URL(base).hostname, "127.0.0.1");
const out = resolve(
  process.env.ATTACHMENT_QA_OUTPUT ?? "/tmp/niaro-attachment-recovery",
);
await mkdir(out, { recursive: true });
for (const name of ["A", "B", "C"])
  await writeFile(resolve(out, `${name}.txt`), `TEST ${name} source file`);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.ATTACHMENT_CHROMIUM,
});
const page = await browser.newPage({ viewport: { width: 520, height: 844 } });
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
// A labelled synthetic historical reply exposes the real assistant Again action.
// It is a valid HTTP projection fixture, never a model/processing success claim.
await page.route("**/commands?**", async (route) => {
  const response = await route.fetch();
  const value = await response.json();
  const conversation = value.snapshot?.conversations?.find(
    (item) => item.id === "conversation-1",
  );
  const source = conversation?.messages
    .filter((message) => message.role === "user")
    .at(-1);
  if (value.status === "accepted" && source?.attachments?.length)
    conversation.messages.push({
      id: `TEST-reply-${source.id}`,
      role: "assistant",
      text: "TEST synthetic historical reply; no model call",
      replyToCommandId: source.id,
    });
  await route.fulfill({ response, json: value });
});
const evidence = () =>
  page.evaluate(() => fetch("/evidence").then((response) => response.json()));
async function source(caption) {
  await page.goto(base);
  await page.getByRole("textbox").fill(caption);
  for (const [index, name] of ["A", "B", "C"].entries()) {
    await page.getByRole("button", { name: "Attach", exact: true }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: "File", exact: true }).click();
    await (await chooser).setFiles(resolve(out, `${name}.txt`));
    await page.waitForFunction(
      (count) =>
        window.niaroAttachmentClient.attachments.getSnapshot().entries
          .length === count && window.niaroAttachmentClient.attachments.ready,
      index + 1,
    );
  }
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForFunction(
    () =>
      window.niaroAttachmentClient.attachments.getSnapshot().entries.length ===
      0,
  );
  await page.getByText(caption, { exact: true }).last().waitFor();
  return (await evidence()).commands;
}
async function explicitSend(text, originalCommands) {
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForFunction(
    () =>
      window.niaroAttachmentClient.attachments.getSnapshot().entries.length ===
      0,
  );
  const last = await page.evaluate(() =>
    window.niaroAttachmentClient
      .getSnapshot()
      .store.conversations["conversation-1"].messages.filter(
        (message) => message.role === "user",
      )
      .at(-1),
  );
  assert.equal(last.text, text);
  assert.equal(last.attachments.length, 3);
  assert.equal((await evidence()).commands, originalCommands + 1);
}
try {
  for (const action of ["Edit", "Again"]) {
    const caption = `TEST ${action} original caption`;
    const commands = await source(caption);
    await page.getByRole("textbox").fill("TEST unrelated draft");
    let references = 0;
    await page.route("**/references?*", async (route) => {
      const response = await route.fetch();
      references++;
      if ([2, 4].includes(references)) await route.abort("failed");
      else await route.fulfill({ response });
    });
    await page
      .getByRole("button", { name: action, exact: true })
      .last()
      .click();
    await page
      .getByRole("button", { name: "Retry upload: B.txt", exact: true })
      .waitFor();
    assert.equal(await page.getByRole("textbox").inputValue(), caption);
    await page
      .getByRole("button", { name: "Retry upload: B.txt", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Retry upload: C.txt", exact: true })
      .waitFor();
    assert.equal(await page.getByRole("textbox").inputValue(), caption);
    const edited = `TEST ${action} intentional newer edit`;
    await page.getByRole("textbox").fill(edited);
    await page
      .getByRole("button", { name: "Retry upload: C.txt", exact: true })
      .click();
    await page.waitForFunction(
      () => window.niaroAttachmentClient.attachments.ready,
    );
    assert.equal(await page.getByRole("textbox").inputValue(), edited);
    assert.equal((await evidence()).commands, commands);
    await explicitSend(edited, commands);
    await page.unroute("**/references?*");
    checks.push(
      `${action}: compound accepted-response loss retains source caption, newer edit wins, Retry never sends, explicit Send retains three files`,
    );
  }

  const commands = await source("TEST successful Again source");
  await page.getByRole("button", { name: "Again", exact: true }).last().click();
  await page.waitForFunction(
    async (count) =>
      (await fetch("/evidence").then((response) => response.json()))
        .commands === count,
    commands + 1,
  );
  await page.waitForFunction(
    () =>
      window.niaroAttachmentClient.attachments.getSnapshot().entries.length ===
      0,
  );
  assert.equal((await evidence()).commands, commands + 1);
  assert.equal(await page.getByRole("textbox").inputValue(), "");
  checks.push(
    "successful explicit Again sends once and clears only its owned source caption",
  );

  for (const scopeChange of [false, true]) {
    const commands = await source(
      `TEST ${scopeChange ? "scope" : "pending"} source`,
    );
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let references = 0;
    await page.route("**/references?*", async (route) => {
      const response = await route.fetch();
      references++;
      if (references === 1) await held;
      await route.fulfill({ response }).catch(() => {});
    });
    await page
      .getByRole("button", { name: "Again", exact: true })
      .last()
      .click();
    await page.waitForFunction(
      () => window.niaroAttachmentClient.attachments.getSnapshot().busy,
    );
    // Wait until the route owns the actual first response, rather than only local hash work.
    while (!references) await new Promise((resolve) => setTimeout(resolve, 5));
    if (scopeChange)
      await page.evaluate(() =>
        window.niaroAttachmentSelectConversation(undefined),
      );
    const newer = scopeChange
      ? "TEST newer conversation draft"
      : "TEST newer edit during pin preparation";
    await page.getByRole("textbox").fill(newer);
    release();
    if (!scopeChange)
      await page.waitForFunction(
        () => window.niaroAttachmentClient.attachments.ready,
      );
    else await page.waitForTimeout(100);
    assert.equal(await page.getByRole("textbox").inputValue(), newer);
    assert.equal((await evidence()).commands, commands);
    if (!scopeChange) await explicitSend(newer, commands);
    else
      assert.equal(
        await page.evaluate(
          () =>
            window.niaroAttachmentClient.attachments.getSnapshot().entries
              .length,
        ),
        0,
      );
    await page.unroute("**/references?*");
    checks.push(
      scopeChange
        ? "new conversation/draft owns late Again completion; no stale Send"
        : "new edit during initial Again preparation cancels automatic completion; explicit Send remains",
    );
  }
  assert.deepEqual(errors, []);
  await page.screenshot({ path: resolve(out, "final-newer-scope.png") });
  await writeFile(
    resolve(out, "recovery.json"),
    JSON.stringify(
      {
        base,
        syntheticHistoricalReply:
          "Labelled valid assistant DTO at HTTP fixture boundary; no model or processing-success claim",
        browser: await browser.version(),
        checks,
        errors,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  await browser.close();
}
