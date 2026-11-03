import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedPreview } from "../apps/server-identity/bounded-preview";
import { projectResult } from "../apps/server-identity/mastra-domain";
import {
  fitReadResult,
  TRUNCATION_MARKER,
} from "../apps/server-identity/result-budget";

test("a large MCP list result becomes a marked preview with its length", () => {
  const records = Array.from({ length: 200 }, (_, i) => ({
    id: `TEST-${i}`,
    name: `TEST company ${i}`,
  }));
  const result = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          success: true,
          message: "Found 200 company records",
          result: { records },
        }),
      },
    ],
  };
  const preview = boundedPreview(result, 4000) as {
    preview: {
      message: string;
      result: { records: { total: number; shown: number } };
    };
    truncated: boolean;
  };
  assert.equal(preview.truncated, true);
  assert.equal(preview.preview.message, "Found 200 company records");
  assert.equal(preview.preview.result.records.total, 200);
  assert(preview.preview.result.records.shown <= 5);
  assert(Buffer.byteLength(JSON.stringify(preview)) <= 4000);
  // Small results pass unchanged.
  assert.deepEqual(boundedPreview({ a: 1 }, 4000), { a: 1 });
});

test("projectResult reads an MCP text result as its JSON and keeps long text", () => {
  const events = Array.from({ length: 24 }, (_, i) => ({
    subject: `TEST event ${i}`,
    start: {
      dateTime: `2026-10-${String(17 + (i % 8)).padStart(2, "0")}T08:30:00`,
    },
    attendees: [
      { emailAddress: { name: "TEST Anna", address: "anna@example.test" } },
    ],
  }));
  const result = {
    _meta: { http_status: 200 },
    content: [{ type: "text", text: JSON.stringify({ value: events }) }],
  };
  const projected = projectResult(result, 12000) as {
    value: { subject: string }[] | { items: unknown[]; total: number };
  };
  assert(Array.isArray(projected.value));
  assert.equal(projected.value.length, 24);
  assert.equal(projected.value[0]!.subject, "TEST event 0");
  // A long plain text is cut, not dropped.
  const text = projectResult({ note: "x".repeat(5000) }, 2000) as {
    note: string;
  };
  assert(text.note.startsWith("xxx") && text.note.endsWith("…"));
  assert(text.note.length <= 1201);
  // A list beyond the budget keeps its first items and its length.
  const many = projectResult({ value: events }, 2000) as {
    value: { items: unknown[]; total: number; truncated: true };
  };
  assert.equal(many.value.total, 24);
  assert(many.value.items.length < 24);
});

test("a projection that fills its budget shrinks the text instead of dropping the data", () => {
  const snippet = "Příliš žluťoučký kůň úpěl ďábelské ódy. ".repeat(17);
  const items = Array.from({ length: 20 }, (_, id) => ({
    id,
    subject: `Předmět ${id}`,
    snippet,
  }));
  for (const max of [12000, 6000, 2500, 1000]) {
    const projected = projectResult(items, max);
    assert.ok(Buffer.byteLength(JSON.stringify(projected)) <= max);
    const kept = Array.isArray(projected)
      ? projected
      : (projected as { items: unknown[] }).items;
    assert.ok(kept.length >= 10, `${max}: kept ${kept.length} items`);
  }
});

test("an Outlook message with a long quoted history keeps its newest part within the receipt budget", () => {
  const newest = "TEST newest reply: the meeting moves to Friday.";
  const history = "<blockquote>TEST older quoted message</blockquote>".repeat(
    4000,
  );
  const message = {
    id: "TEST-message",
    subject: "TEST Re: meeting",
    from: { emailAddress: { address: "jane@example.test" } },
    body: { contentType: "html", content: newest + history },
  };
  const result = {
    content: [{ type: "text", text: JSON.stringify(message) }],
  };
  assert(JSON.stringify(result).length > 65536);
  const fitted = fitReadResult(result, 65536) as {
    content: { type: string; text: string }[];
  };
  assert(JSON.stringify(fitted).length <= 65536);
  // Still one text block of valid JSON: the model reads it as data.
  const inner = JSON.parse(fitted.content[0]!.text);
  assert.equal(inner.truncated, true);
  assert.equal(inner.id, "TEST-message");
  assert.equal(inner.subject, "TEST Re: meeting");
  assert.equal(inner.from.emailAddress.address, "jane@example.test");
  assert(inner.body.content.startsWith(newest));
  assert(inner.body.content.endsWith(TRUNCATION_MARKER));
  // The model's projection sees the start too, and the cut.
  const projected = JSON.stringify(projectResult(fitted));
  assert.match(projected, /TEST newest reply/);
  assert.match(projected, /"truncated":true/);
});

test("a long list keeps its first items, a small result is untouched, and an uncuttable one is refused", () => {
  const list = {
    value: Array.from({ length: 2000 }, (_, i) => ({
      id: `TEST-${i}`,
      subject: `TEST subject ${i}`,
    })),
  };
  const fitted = fitReadResult(list, 65536) as {
    value: { id: string }[];
    truncated: true;
  };
  assert(JSON.stringify(fitted).length <= 65536);
  assert.equal(fitted.truncated, true);
  assert.equal(fitted.value[0]!.id, "TEST-0");
  assert(fitted.value.length < 2000);
  const small = { value: [{ id: "TEST-1" }] };
  assert.equal(fitReadResult(small, 65536), small);
  const keys = Object.fromEntries(
    Array.from({ length: 7000 }, (_, i) => [`TEST-field-${i}`, i]),
  );
  assert.equal(fitReadResult(keys, 65536), undefined);
});
