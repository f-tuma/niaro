// Shared helpers for the pilot smoke test: a step recorder and an HTTP
// client with a cookie jar that sends the same-origin headers the
// administration API requires.
import assert from "node:assert/strict";

export { assert };

export class StepFailed extends Error {}

/** Records PASS / FAIL / SKIP per step. A failed hard step stops its journey. */
export class Report {
  constructor() {
    this.results = [];
  }
  async step(journey, name, run, { soft = false } = {}) {
    const started = Date.now();
    try {
      const value = await run();
      this.results.push({
        journey,
        name,
        status: "PASS",
        ms: Date.now() - started,
      });
      console.log(`  PASS  ${name}`);
      return value;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.results.push({
        journey,
        name,
        status: "FAIL",
        ms: Date.now() - started,
        detail,
      });
      console.log(
        `  FAIL  ${name}\n        ${detail.split("\n").join("\n        ")}`,
      );
      if (!soft) throw new StepFailed(name);
      return undefined;
    }
  }
  skip(journey, name, reason) {
    this.results.push({ journey, name, status: "SKIP", ms: 0, detail: reason });
    console.log(`  SKIP  ${name}: ${reason}`);
  }
  get failed() {
    return this.results.some((r) => r.status === "FAIL");
  }
  summary() {
    const width = Math.max(
      ...this.results.map((r) => r.journey.length + r.name.length + 3),
      20,
    );
    const lines = ["", "Smoke test summary", "=".repeat(width + 12)];
    for (const r of this.results)
      lines.push(
        `${r.status.padEnd(5)} ${`${r.journey} / ${r.name}`.padEnd(width)} ${String(r.ms).padStart(6)} ms${r.status !== "PASS" && r.detail ? `\n      ${r.detail.split("\n")[0].slice(0, 200)}` : ""}`,
      );
    const count = (s) => this.results.filter((r) => r.status === s).length;
    lines.push("=".repeat(width + 12));
    lines.push(
      `${count("PASS")} passed, ${count("FAIL")} failed, ${count("SKIP")} skipped`,
    );
    lines.push(this.failed ? "RESULT: FAIL" : "RESULT: PASS");
    return lines.join("\n");
  }
}

/**
 * One browser-like party: keeps its own cookies, always names the public
 * origin, and marks POSTs the way the web app does (X-Agent-Admin: 1, JSON).
 */
export class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }
  async request(
    method,
    path,
    { body, bearer, headers = {}, timeout = 60_000 } = {},
  ) {
    const response = await fetch(`${this.base}${path}`, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
      headers: {
        Origin: this.base,
        ...(this.cookies.size
          ? {
              Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
            }
          : {}),
        ...(body !== undefined
          ? { "Content-Type": "application/json", "X-Agent-Admin": "1" }
          : {}),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      const expired = attributes.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (!value || expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, json, text, headers: response.headers };
  }
  get(path, options) {
    return this.request("GET", path, options);
  }
  post(path, body, options) {
    return this.request("POST", path, { ...options, body });
  }
}

/** Asserts the status and returns the JSON body, naming the server's error code. */
export function expectStatus(result, status, what) {
  if (result.status !== status)
    throw new Error(
      `${what}: expected HTTP ${status}, got ${result.status} ${result.text.slice(0, 300)}`,
    );
  return result.json;
}

export const delay = (ms) => new Promise((ok) => setTimeout(ok, ms));
