// Browser pilot journey with an externally installed Playwright (nothing is
// added to the repository): the member signs in on "/", sees the hub, chats,
// opens Tasks, Processes, Connections and Account at 1440 px and 390 px; the
// owner opens administration and sees the first-run checklist.
//
// Playwright is found through PLAYWRIGHT_CORE (or NIARO_PLAYWRIGHT_MODULE):
// a path to a playwright / playwright-core package directory or entry file,
// otherwise a `playwright` / `playwright-core` package resolvable from the
// repository. CHROMIUM optionally names the browser executable (for example a
// chrome-headless-shell); otherwise Playwright uses its own browser cache.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assert, StepFailed } from "./lib.mjs";

const J = "browser";
const PAGES = ["/tasks", "/processes", "/connections", "/me"];

export async function loadPlaywright() {
  const explicit =
    process.env.PLAYWRIGHT_CORE || process.env.NIARO_PLAYWRIGHT_MODULE;
  const candidates = explicit ? [explicit] : ["playwright", "playwright-core"];
  const errors = [];
  for (const candidate of candidates) {
    let specifier = candidate;
    if (explicit) {
      const path = resolve(candidate);
      specifier = pathToFileURL(
        existsSync(path) && statSync(path).isDirectory()
          ? ([join(path, "index.mjs"), join(path, "index.js")].find(
              existsSync,
            ) ?? path)
          : path,
      ).href;
    }
    try {
      const module = await import(specifier);
      const chromium = module.chromium ?? module.default?.chromium;
      if (chromium) return { chromium, source: candidate };
      errors.push(`${candidate}: no chromium export`);
    } catch (error) {
      errors.push(`${candidate}: ${error.code ?? error.message}`);
    }
  }
  return { chromium: null, reason: errors.join("; ") };
}

/** Third-party noise (extensions, CSP reports for other origins) is not ours. */
function relevantConsoleError(text, base) {
  if (/chrome-extension:\/\//.test(text)) return false;
  if (/Content Security Policy/i.test(text)) {
    const urls = text.match(/https?:\/\/[^\s'"]+/g) ?? [];
    return urls.some((u) => u.startsWith(base));
  }
  return true;
}

export async function browserJourney(report, { base, accounts, outputDir }) {
  const { chromium, source, reason } = await loadPlaywright();
  if (!chromium) {
    report.skip(
      J,
      "browser journey",
      `no Playwright runtime (${reason}); set PLAYWRIGHT_CORE=<path to playwright-core> and optionally CHROMIUM=<browser executable>`,
    );
    return;
  }
  const executablePath = process.env.CHROMIUM || undefined;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath });
  } catch (error) {
    report.skip(
      J,
      "browser journey",
      `Playwright from ${source} could not start a browser (${String(error.message).split("\n")[0]}); set CHROMIUM=<chromium or chrome-headless-shell executable>`,
    );
    return;
  }
  console.log(
    `  (browser: Playwright from ${source}${executablePath ? `, ${executablePath}` : ""})`,
  );
  mkdirSync(outputDir, { recursive: true });
  const step = (name, run, options) => report.step(J, name, run, options);
  const shot = (page, name) =>
    page
      .screenshot({ path: join(outputDir, `${name}.png`), fullPage: true })
      .catch(() => {});

  async function newParty(label) {
    const context = await browser.newContext({
      baseURL: base,
      locale: "en-US",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const errors = [];
    const party = { context, page, errors, signedIn: false };
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      const source = message.location()?.url ?? "";
      // Signed out, the app asks who is signed in and gets the expected 401.
      if (
        !party.signedIn &&
        /status of 401/.test(text) &&
        source === `${base}/admin/api/identity`
      )
        return;
      // Without a configured model the chat turn is a settled refusal (422).
      if (/status of 422/.test(text) && /\/v1\/[^/]+\/commands/.test(source))
        return;
      if (relevantConsoleError(text, base))
        errors.push(
          `${label} ${page.url().replace(base, "")}: ${text}${source ? ` (${source.replace(base, "")})` : ""}`,
        );
    });
    page.on("pageerror", (error) =>
      errors.push(
        `${label} ${page.url().replace(base, "")}: uncaught ${error.message}`,
      ),
    );
    return party;
  }

  async function signIn(party, account) {
    const { page } = party;
    await page.goto("/");
    await page.locator("#app-email").fill(account.email);
    await page.locator("#app-password").fill(account.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .locator("#app-email")
      .waitFor({ state: "detached", timeout: 30_000 });
    party.signedIn = true;
  }

  const noHorizontalScroll = async (page, path) => {
    const sizes = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      width: window.innerWidth,
    }));
    assert.ok(
      sizes.scroll <= sizes.width && sizes.body <= sizes.width,
      `${path}: horizontal scroll at ${sizes.width}px (document ${sizes.scroll}px, body ${sizes.body}px)`,
    );
  };

  const settled = (page) =>
    page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  // Member and owner parts are independent: a failed member step still lets
  // the owner part run.
  const part = async (run) => {
    try {
      await run();
    } catch (error) {
      if (!(error instanceof StepFailed)) throw error;
    }
  };
  try {
    await part(async () => {
      const member = await newParty("member");
      let chatPath;
      const { page } = member;

      await step("member signs in on / and sees the hub", async () => {
        await signIn(member, accounts.member);
        await page.getByTestId("hub-tasks").waitFor({ timeout: 30_000 });
        // The dashboard's ask box hands its text to a new chat at /chat.
        await page
          .getByRole("textbox", { name: "Ask the assistant…" })
          .waitFor();
        assert.equal(
          await page.locator('a[href="/admin/"]').count(),
          0,
          "a member has no administration link",
        );
        await shot(page, "member-hub");
      });

      await step(
        "member opens the widget gallery in edit mode (grid cells shown)",
        async () => {
          await page.getByRole("button", { name: "Edit", exact: true }).click();
          await page
            .getByTestId("hub-slot")
            .first()
            .waitFor({ timeout: 15_000 });
          await page
            .getByRole("button", { name: "Add widget", exact: true })
            .click();
          await page.getByTestId("hub-gallery").waitFor({ timeout: 15_000 });
          assert.ok(
            (await page.getByTestId("gallery-type").count()) >= 8,
            "the gallery lists the widget types",
          );
          await settled(page);
          await shot(page, "member-hub-gallery");
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: "Done", exact: true }).click();
        },
        { soft: true },
      );

      await step(
        "member sends a chat message and sees it with a settled answer",
        async () => {
          const text = `Smoke test message ${Date.now()}`;
          await page.goto("/chat");
          const composer = page.getByRole("textbox", {
            name: "Message the assistant",
          });
          await composer.fill(text);
          await composer.press("Enter");
          await page.waitForURL(/\/chat\/[A-Za-z0-9_-]+$/, { timeout: 30_000 });
          chatPath = new URL(page.url()).pathname;
          const mine = page.locator("article").filter({ hasText: text });
          await mine.first().waitFor({ timeout: 30_000 });
          // Terminal: nothing pending, and an answer or a settled refusal is shown.
          await page
            .getByTestId("pending-message")
            .waitFor({ state: "detached", timeout: 90_000 });
          const answer = page
            .locator("article")
            .filter({ hasNotText: text })
            .or(page.getByTestId("chat-error"));
          await answer.first().waitFor({ timeout: 60_000 });
          await settled(page);
          await shot(page, "member-chat");
          // The chat survives a reload at its own address.
          await page.reload();
          await mine.first().waitFor({ timeout: 30_000 });
        },
        { soft: true },
      );

      await step(
        "member opens Tasks, Processes, Connections and Account",
        async () => {
          for (const path of PAGES) {
            await page.goto(path);
            await page.locator("main").first().waitFor({ timeout: 15_000 });
            await settled(page);
            assert.equal(
              new URL(page.url()).pathname,
              path,
              `stayed on ${path}`,
            );
            const heading = page.getByRole("heading").first();
            await heading.waitFor({ timeout: 15_000 });
            await shot(page, `member${path.replace("/", "-")}`);
          }
          // Back home: the hub is still there.
          await page.goto("/");
          await page.getByTestId("hub-tasks").waitFor({ timeout: 30_000 });
        },
        { soft: true },
      );

      await step(
        "no horizontal scroll at 390 px (hub, chat and pages)",
        async () => {
          // The same tab, resized: a second tab of the same browser would
          // replace this tab's chat credential (see the smoke test notes).
          await page.setViewportSize({ width: 390, height: 844 });
          const paths = ["/", ...(chatPath ? [chatPath] : []), ...PAGES];
          for (const path of paths) {
            await page.goto(path);
            await page.locator("main").first().waitFor({ timeout: 15_000 });
            await settled(page);
            await noHorizontalScroll(page, path);
            const label =
              path === "/"
                ? "hub"
                : path.startsWith("/chat/")
                  ? "chat"
                  : path.slice(1);
            await shot(page, `member-390-${label}`);
          }
          await page.setViewportSize({ width: 1440, height: 900 });
        },
        { soft: true },
      );

      await step(
        "member console has no errors",
        async () => {
          assert.deepEqual(member.errors, [], member.errors.join("\n"));
        },
        { soft: true },
      );
      await member.context.close();
    });

    await part(async () => {
      const owner = await newParty("owner");
      await step(
        "owner signs in and opens administration with the setup checklist",
        async () => {
          await signIn(owner, accounts.owner);
          await owner.page
            .getByTestId("hub-tasks")
            .waitFor({ timeout: 30_000 });
          const adminLink = owner.page.locator('a[href="/admin/"]');
          assert.ok(
            (await adminLink.count()) > 0,
            "the owner's menu links to administration",
          );
          await owner.page.goto("/admin/");
          await settled(owner.page);
          await shot(owner.page, "owner-admin-landing");
          await owner.page
            .getByRole("progressbar", { name: "Get started" })
            .waitFor({ timeout: 30_000 });
          await owner.page
            .getByText("Get started", { exact: true })
            .first()
            .waitFor();
          await settled(owner.page);
          await shot(owner.page, "owner-admin-overview");
          await owner.page.setViewportSize({ width: 390, height: 844 });
          await noHorizontalScroll(owner.page, "/admin/");
        },
        { soft: true },
      );
      await step(
        "owner console has no errors",
        async () => {
          assert.deepEqual(owner.errors, [], owner.errors.join("\n"));
        },
        { soft: true },
      );
      await owner.context.close();
    });
  } finally {
    await browser.close();
  }
}
