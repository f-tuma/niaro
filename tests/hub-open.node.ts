import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  HUB_DOC_LIMITS,
  HUB_ITEM_TEXT_MAX,
  HUB_PROFILE_V3,
  HubItemDetailSchema,
  type HubDocNode,
} from "../packages/protocol/hub";
import { IdentityError } from "../apps/server-identity/error";
import { createHub } from "../apps/server-identity/hub";
import {
  HUB_OPEN_CAPS,
  HUB_OPEN_LIMITS,
  HUB_PREFETCH_LIMIT,
  createHubFillAccess,
  refPaths,
  runHubOpen,
  runHubPrefetch,
  withRef,
  type HubOpenInput,
} from "../apps/server-identity/hub-fill";
import {
  extractHubItemDetail,
  htmlToDoc,
  htmlToText,
} from "../apps/server-identity/hub-open";
import {
  HUB_DETAIL_TTL_MS,
  HubStore,
  type HubOpenRecipe,
} from "../apps/server-identity/hub-store";
import {
  createTrustHarness,
  type ModelRequest,
  type TrustHarness,
} from "./agent-trust/harness";

/*
 * Opening one email of the inbox widget in full: the message is extracted
 * on the server from the service's read result, never rewritten by a model;
 * the agent only finds the read, within two reads and no assembly step.
 */
const code = (value: string) => (error: unknown) =>
  error instanceof IdentityError && error.code === value;
const toolOutputs = (body: ModelRequest) =>
  (body.messages ?? [])
    .filter((message) => message.role === "tool")
    .map(
      (message) =>
        JSON.parse(String((message as { content: unknown }).content)) as Record<
          string,
          any
        >,
    );

const graphMessage = {
  id: "AAMkAGE1-TEST-1",
  subject: "TEST Cenová nabídka",
  from: {
    emailAddress: { name: "Jana Nováková", address: "jana@example.test" },
  },
  toRecipients: [
    { emailAddress: { name: "Jan", address: "jan@example.test" } },
    { emailAddress: { address: "obchod@example.test" } },
  ],
  receivedDateTime: "2026-10-17T06:30:00Z",
  webLink: "https://outlook.example.test/mail/1",
  bodyPreview: "Dobrý den, posílám nabídku.",
  body: {
    contentType: "html",
    content:
      "<html><head><style>p{color:red}</style><title>x</title></head><body><script>alert(1)</script><div><p>Dobrý den,</p><p>posílám <b>nabídku</b> &amp; ceník&nbsp;na&#160;rok&#32;&#x32;027.</p><ul><li>Cena: 1&nbsp;000&nbsp;Kč</li><li>Platnost do pátku</li></ul><br/><br/><br/><p>S pozdravem,<br>Jana</p></div></body></html>",
  },
};

test("an HTML body becomes plain text: styles and scripts go, blocks become lines, entities decode", () => {
  assert.equal(
    htmlToText(graphMessage.body.content),
    "Dobrý den,\n\nposílám nabídku & ceník na rok 2027.\n\nCena: 1 000 Kč\nPlatnost do pátku\n\nS pozdravem,\nJana",
  );
  assert.equal(htmlToText("a<br>b<br/>c"), "a\nb\nc");
  assert.equal(htmlToText("<p>x</p>\n\n\n\n<p>y</p>"), "x\n\ny");
});

const tags = (nodes: HubDocNode[]): unknown[] =>
  nodes.map((node) =>
    node.t === "text"
      ? node.v
      : [node.tag, ...(node.children ? [tags(node.children)] : [])],
  );

test("an HTML body becomes a bounded tree of allowed tags: dangerous content, attributes and URLs go", () => {
  const { doc, truncated } = htmlToDoc(
    "<html><head><title>t</title><style>p{color:red}</style></head><body>" +
      '<script>alert(1)</script><noscript>no</noscript><iframe src="https://x">x</iframe>' +
      '<p onclick="steal()" style="color:red" class="x" id="y">Hi <b>there</b>, <i>you</i> <strike>old</strike> <font color="red">red</font></p>' +
      '<a href="javascript:alert(1)">bad</a> <a href="https://x.test/a?b=1&amp;c=2" onmouseover="x()">ok</a> <a href="mailto:a@b.test">mail</a> <a href="http://plain.test/">plain</a>' +
      "<hr><ul><li>one</li><li>two<ol><li>deep</li></ol></li></ul>" +
      '<img src="http://x/i.png" alt="insecure"><img src="https://x/i.png" alt="pic" onerror="x()"><img src="data:image/png;base64,AAAA">' +
      '<table><tr><th colspan="2" rowspan="99">h</th></tr><tr><td>c</td><td></td></tr></table>' +
      "<blockquote>q</blockquote><h1>H</h1><pre>a\n  b</pre><center>c</center><span></span><div><div></div></div>" +
      "<form><input value=1><button>b</button></form><svg><circle/></svg><custom-tag>kept text</custom-tag>" +
      "</body></html>",
  );
  assert.equal(truncated, false);
  assert.deepEqual(tags(doc), [
    [
      "p",
      [
        "Hi ",
        ["strong", ["there"]],
        ", ",
        ["em", ["you"]],
        " ",
        ["s", ["old"]],
        " ",
        ["span", ["red"]],
      ],
    ],
    ["span", ["bad"]],
    " ",
    ["a", ["ok"]],
    " ",
    ["a", ["mail"]],
    " ",
    ["a", ["plain"]],
    ["hr"],
    [
      "ul",
      [
        ["li", ["one"]],
        ["li", ["two", ["ol", [["li", ["deep"]]]]]],
      ],
    ],
    "insecure",
    ["img"],
    [
      "table",
      [
        [
          "tbody",
          [
            ["tr", [["th", ["h"]]]],
            ["tr", [["td", ["c"]], ["td"]]],
          ],
        ],
      ],
    ],
    ["blockquote", ["q"]],
    ["h1", ["H"]],
    ["pre", ["a\n  b"]],
    ["div", ["c"]],
    "kept text",
  ]);
  const links = doc.filter((node) => node.t === "el" && node.tag === "a");
  assert.deepEqual(
    links.map((node) => (node.t === "el" ? node.href : "")),
    ["https://x.test/a?b=1&c=2", "mailto:a@b.test", "http://plain.test/"],
  );
  const image = doc.find((node) => node.t === "el" && node.tag === "img")!;
  assert.deepEqual(image, {
    t: "el",
    tag: "img",
    src: "https://x/i.png",
    alt: "pic",
  });
  // Only the listed attributes survive, bounded.
  const table = doc.find((node) => node.t === "el" && node.tag === "table")!;
  const th = JSON.stringify(table).includes('"colspan":2');
  assert(th);
  assert(!JSON.stringify(doc).includes("rowspan"));
  for (const key of ["onclick", "style", "class", "onerror", "onmouseover"])
    assert(!JSON.stringify(doc).includes(key));
  // Limits: depth, node count and size mark the tree as cut.
  assert.equal(
    htmlToDoc("<div>".repeat(HUB_DOC_LIMITS.depth + 2) + "x").truncated,
    true,
  );
  assert.equal(
    htmlToDoc("<div>".repeat(HUB_DOC_LIMITS.depth - 1) + "x").truncated,
    false,
  );
  const many = htmlToDoc("<p>x</p>".repeat(HUB_DOC_LIMITS.nodes));
  assert.equal(many.truncated, true);
  assert(many.doc.length <= HUB_DOC_LIMITS.nodes);
  const big = htmlToDoc("<p>" + "y".repeat(HUB_DOC_LIMITS.bytes + 10) + "</p>");
  assert.equal(big.truncated, true);
  assert(JSON.stringify(big.doc).length <= HUB_DOC_LIMITS.bytes + 100);
  // A long text is several text nodes, each within the bound.
  const long = htmlToDoc(
    "<p>" + "z".repeat(HUB_DOC_LIMITS.text * 2 + 1) + "</p>",
  );
  assert.equal(long.truncated, false);
  const paragraph = long.doc[0]!;
  assert.equal(paragraph.t === "el" && paragraph.children?.length, 3);
  // The whole detail says it was cut when the tree was.
  const cut = extractHubItemDetail(
    {
      subject: "s",
      from: "a",
      body: { contentType: "html", content: "<div>".repeat(30) + "x" },
    },
    "x",
  );
  assert.equal(cut?.truncated, true);
});

test("table rows and tables with nothing to read are dropped; rows with text stay", () => {
  const { doc } = htmlToDoc(
    "<table><tr><td>Jméno</td><td>Konec</td></tr><tr><td> </td><td></td></tr><tr><td><span></span></td></tr></table><table><tr><td></td></tr></table><p>konec</p>",
  );
  const tables = doc.filter((node) => node.t === "el" && node.tag === "table");
  assert.equal(tables.length, 1);
  const rows = JSON.stringify(tables[0]).match(/"tag":"tr"/g) ?? [];
  assert.equal(rows.length, 1);
  const last = doc.at(-1);
  assert.equal(last?.t === "el" ? last.tag : null, "p");
});
test("the message is extracted deterministically from the shapes services return", () => {
  // Microsoft Graph: people, date, link and the HTML body as text.
  const graph = extractHubItemDetail(graphMessage, graphMessage.id);
  assert.deepEqual(graph, {
    subject: "TEST Cenová nabídka",
    from: "Jana Nováková <jana@example.test>",
    to: ["Jan <jan@example.test>", "obchod@example.test"],
    at: "2026-10-17T06:30:00.000Z",
    text: "Dobrý den,\n\nposílám nabídku & ceník na rok 2027.\n\nCena: 1 000 Kč\nPlatnost do pátku\n\nS pozdravem,\nJana",
    doc: graph!.doc,
    link: "https://outlook.example.test/mail/1",
  });
  // The HTML body also as the tree the page renders: blocks, no style/script.
  const wrapper = graph!.doc![0]!;
  assert.equal(graph!.doc!.length, 1);
  assert.equal(wrapper.t === "el" && wrapper.tag, "div");
  const blocks = wrapper.t === "el" ? wrapper.children! : [];
  assert.deepEqual(
    blocks.map((node) => (node.t === "el" ? node.tag : "text")),
    ["p", "p", "ul", "br", "br", "br", "p"],
  );
  assert.deepEqual(blocks[1], {
    t: "el",
    tag: "p",
    children: [
      { t: "text", v: "posílám " },
      { t: "el", tag: "strong", children: [{ t: "text", v: "nabídku" }] },
      { t: "text", v: " & ceník na rok 2027." },
    ],
  });
  assert(HubItemDetailSchema.safeParse(graph).success);
  // A text body has no tree.
  assert.equal(
    extractHubItemDetail({ subject: "s", from: "a", text: "plain" }, "x")?.doc,
    undefined,
  );
  // A text body stays as it is (line endings normalised); no `to`, no link.
  assert.deepEqual(
    extractHubItemDetail(
      {
        subject: "Plain",
        from: "bob@example.test",
        body: {
          contentType: "text",
          content: "Hi,\r\n\r\nplain <not a tag>.\r\n",
        },
      },
      "x",
    ),
    {
      subject: "Plain",
      from: "bob@example.test",
      text: "Hi,\n\nplain <not a tag>.",
    },
  );
  // An MCP result: one text block holding the JSON message.
  assert.equal(
    extractHubItemDetail(
      {
        content: [
          { type: "text", text: JSON.stringify({ value: graphMessage }) },
        ],
      },
      graphMessage.id,
    )?.subject,
    "TEST Cenová nabídka",
  );
  // A list: the message with the asked id, not the first one.
  const list = {
    value: [{ ...graphMessage, id: "other", subject: "Other" }, graphMessage],
  };
  assert.equal(
    extractHubItemDetail(list, graphMessage.id)?.subject,
    "TEST Cenová nabídka",
  );
  // Without the asked id a list holds no answer: never another email.
  assert.equal(extractHubItemDetail(list, "unknown"), null);
  // Nor does a single message that names another id; one without an id is it.
  assert.equal(extractHubItemDetail(graphMessage, "unknown"), null);
  assert.equal(
    extractHubItemDetail({ value: [{ ...graphMessage, id: undefined }] }, "x")
      ?.subject,
    "TEST Cenová nabídka",
  );
  // Gmail: headers and a base64url text part.
  const gmail = {
    id: "18f",
    internalDate: String(Date.parse("2026-10-17T06:30:00Z")),
    payload: {
      headers: [
        { name: "Subject", value: "TEST gmail" },
        { name: "From", value: "Ann <ann@example.test>" },
        { name: "To", value: "me@example.test" },
      ],
      parts: [
        {
          mimeType: "text/html",
          body: { data: Buffer.from("<p>html</p>").toString("base64url") },
        },
        {
          mimeType: "text/plain",
          body: { data: Buffer.from("Hello from Gmail").toString("base64url") },
        },
      ],
    },
  };
  assert.deepEqual(extractHubItemDetail(gmail, "18f"), {
    subject: "TEST gmail",
    from: "Ann <ann@example.test>",
    to: ["me@example.test"],
    at: "2026-10-17T06:30:00.000Z",
    text: "Hello from Gmail",
  });
  // Nothing that looks like a message: nothing.
  assert.equal(extractHubItemDetail({ value: "TEST-result" }, "x"), null);
  assert.equal(extractHubItemDetail({ subject: "no body" }, "x"), null);
  assert.equal(extractHubItemDetail("just text", "x"), null);
  // Bounded: a long body is cut and marked.
  const long = extractHubItemDetail(
    { subject: "Long", from: "a", body: "x".repeat(HUB_ITEM_TEXT_MAX + 5) },
    "x",
  );
  assert.equal(long?.text.length, HUB_ITEM_TEXT_MAX);
  assert.equal(long?.truncated, true);
  // Only web links pass.
  assert.equal(
    extractHubItemDetail(
      { subject: "s", text: "t", webLink: "javascript:alert(1)" },
      "x",
    )?.link,
    undefined,
  );
});

/** A hub with an inbox widget filled with one email the person may open. */
function hubFixture() {
  const org = "TEST-org";
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE organization(id TEXT PRIMARY KEY);
    CREATE TABLE user(id TEXT PRIMARY KEY);
    CREATE TABLE member(id TEXT PRIMARY KEY, "organizationId" TEXT REFERENCES organization(id) ON DELETE CASCADE, "userId" TEXT REFERENCES user(id) ON DELETE CASCADE);
    CREATE TABLE agent_workspace(id TEXT PRIMARY KEY, organization_id TEXT REFERENCES organization(id) ON DELETE CASCADE);
    CREATE TABLE agent_workspace_member(workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE, member_id TEXT NOT NULL REFERENCES member(id) ON DELETE CASCADE, PRIMARY KEY(workspace_id, member_id)) STRICT;
    INSERT INTO organization VALUES ('${org}');
    INSERT INTO user VALUES ('TEST-anna'), ('TEST-petr');
    INSERT INTO member VALUES ('TEST-m-anna','${org}','TEST-anna'), ('TEST-m-petr','${org}','TEST-petr');
    INSERT INTO agent_workspace VALUES ('${workspaceId}','${org}');
    INSERT INTO agent_workspace_member VALUES ('${workspaceId}','TEST-m-anna'), ('${workspaceId}','TEST-m-petr');`);
  let now = Date.parse("2026-10-17T08:00:00.000Z");
  const store = new HubStore(db, () => now);
  const hub = createHub({
    store,
    processes: {
      unattendedEffect: () => "read",
      activeOutputSchema: () => undefined,
      executionInventory: (actor, scope) => ({
        profile: "agent-process-execution/1",
        scope,
        fingerprint: "f".repeat(64),
        processes: [],
        nextAfter: null,
      }),
    },
    starts: () => undefined,
    journal: () => undefined,
    humanTasks: { open: () => [], openCount: () => 0 },
    timeZone: () => "Europe/Prague",
    now: () => now,
  });
  const actorOf = (userId: string) => ({
    organizationId: org,
    workspaceId,
    userId,
    role: "member" as const,
  });
  const scopeOf = (userId: string) => ({
    serverId: "TEST-server",
    connectionId: "TEST-connection",
    workspaceId,
    userId,
  });
  const known = new Set<string>();
  const add = (userId: string, type: string) => {
    const view = hub.command(actorOf(userId), scopeOf(userId), "cs", {
      profile: HUB_PROFILE_V3,
      type: "add",
      kind: "widget",
      widget: { type },
    }).view as { items: { id: string; kind: string }[] };
    const id = view.items.find(
      (item) => item.kind === "widget" && !known.has(item.id),
    )!.id;
    known.add(id);
    return id;
  };
  return {
    db,
    hub,
    store,
    actorOf,
    add,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const sampleDetail = {
  subject: "TEST Cenová nabídka",
  from: "Jana Nováková <jana@example.test>",
  text: "Dobrý den.",
  doc: [
    {
      t: "el" as const,
      tag: "p" as const,
      children: [{ t: "text" as const, v: "Dobrý den." }],
    },
  ],
};

test("opening needs the person's own inbox widget and a row it holds", () => {
  const { db, hub, actorOf, add } = hubFixture();
  try {
    const anna = actorOf("TEST-anna");
    const inbox = add("TEST-anna", "inbox");
    const recipe = {
      calls: [
        {
          serviceId: randomUUID(),
          serviceRevision: 1,
          actionId: randomUUID(),
          actionRevision: 1,
          input: { folder: "inbox" },
        },
      ],
      services: ["TEST mail"],
    };
    // Answered as asked, so the recipe is kept.
    hub.fillDone(anna, inbox, hub.fillRequest(anna, inbox), {
      data: {
        emails: [
          {
            id: "AAMkAGE1-TEST-1",
            from: "Jana Nováková",
            subject: "TEST Cenová nabídka",
            receivedAt: "2026-10-17T06:30:00Z",
            summary: "TEST čeká na cenu",
            importance: "high",
          },
          {
            from: "Nobody",
            subject: "TEST without id",
            receivedAt: "2026-10-17T05:30:00Z",
            summary: "TEST",
            importance: "low",
          },
        ],
      },
      recipe,
    });
    const request = hub.openRequest(anna, inbox, "AAMkAGE1-TEST-1");
    assert.deepEqual(request, {
      type: "inbox",
      sources: [],
      recipe,
      open: null,
      ref: "AAMkAGE1-TEST-1",
      hint: {
        from: "Jana Nováková",
        subject: "TEST Cenová nabídka",
        receivedAt: "2026-10-17T06:30:00Z",
      },
      timeZone: "Europe/Prague",
    });
    // A row the widget does not hold (or holds without an id).
    assert.throws(
      () => hub.openRequest(anna, inbox, "AAMkAGE1-other"),
      code("hub_item_unknown"),
    );
    // Another person's widget is not theirs to open.
    assert.throws(
      () => hub.openRequest(actorOf("TEST-petr"), inbox, "AAMkAGE1-TEST-1"),
      code("hub_item_not_found"),
    );
    assert.throws(
      () => hub.openRequest(anna, randomUUID(), "AAMkAGE1-TEST-1"),
      code("hub_item_not_found"),
    );
    // Only an inbox opens its rows; other types have nothing to read in full.
    const list = add("TEST-anna", "list");
    hub.fillDone(
      anna,
      list,
      { brief: "TEST", config: { count: 5 } },
      {
        data: { items: [{ title: "AAMkAGE1-TEST-1" }] },
        recipe: { calls: [], services: [] },
      },
    );
    assert.throws(
      () => hub.openRequest(anna, list, "AAMkAGE1-TEST-1"),
      code("hub_widget_invalid"),
    );
    // A widget not filled yet has no rows.
    const empty = add("TEST-anna", "inbox");
    assert.throws(
      () => hub.openRequest(anna, empty, "AAMkAGE1-TEST-1"),
      code("hub_item_unknown"),
    );
  } finally {
    db.close();
  }
});

/** The trust harness's service with a "Read message" read action added. */
function setup(h: TrustHarness) {
  const selected = h.catalog.resolveModel(
    h.target.organizationId,
    h.target.workspaceId,
  )!;
  const serviceId = h.catalog
    .inventory(h.target.organizationId, h.target.workspaceId, {
      userId: h.scope.userId,
      role: "owner",
    })
    .services.find(
      (service) => service.name === "TEST Calendar and contacts",
    )!.id;
  const messageId = h.command({
    type: "saveAction",
    serviceId,
    serviceRevision: h.catalog.service(h.target.workspaceId, serviceId)
      .revision,
    revision: 0,
    settings: {
      name: "TEST Read message",
      description: "One message with its body, by id",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      binding: {
        type: "http",
        method: "GET",
        path: "/messages",
        parameters: [{ name: "id", in: "query", required: true }],
        body: false,
      },
      effect: "read",
      approval: "never",
      enabled: true,
      policy: { roles: ["member"], users: [] },
    },
  });
  const readId = h.catalog
    .service(h.target.workspaceId, serviceId)
    .actions.find((action) => action.name === "TEST Find contact")!.id;
  let runs = 0;
  const open = (input: Partial<HubOpenInput> = {}) => {
    const runId = `hub-open/TEST/${randomUUID()}/${++runs}`;
    return {
      runId,
      result: runHubOpen(
        createHubFillAccess({
          controller: h.controller,
          context: h.context,
          target: h.target,
          selected,
          userId: h.scope.userId,
          runId,
          check: () => {},
          caps: HUB_OPEN_CAPS,
        }),
        {
          type: "inbox",
          sources: [],
          recipe: null,
          ref: graphMessage.id,
          hint: {
            from: "Jana Nováková",
            subject: "TEST Cenová nabídka",
            receivedAt: "2026-10-17T06:30:00Z",
          },
          language: "cs",
          now: Date.parse("2026-10-17T07:00:00.000Z"),
          timeZone: "Europe/Prague",
          runKey: runId,
          ...input,
        },
        new AbortController().signal,
      ),
    };
  };
  return { messageId, readId, open };
}

test("an open runs the read-only agent for the one read, extracts the message on the server and never assembles with a model", async () => {
  const h = createTrustHarness();
  try {
    const { messageId, open } = setup(h);
    h.onService((request) =>
      request.path.endsWith("/messages") ? graphMessage : undefined,
    );
    const collect: ModelRequest[] = [];
    h.onChat((body) => {
      collect.push(body);
      assert(body.tools?.length, "An open never calls the model without tools");
      const outputs = toolOutputs(body);
      if (!outputs.length)
        return h.call("find_actions", {
          service: "TEST Calendar and contacts",
          need: "read one message by id",
        });
      if (outputs.length === 1)
        return h.call("read", {
          action: messageId,
          input: { id: graphMessage.id },
        });
      return { content: "TEST done" };
    });
    const { result, runId } = open();
    const opened = await result;
    const detail = opened.detail;
    // The content as the service returned it, as text; nothing rewritten.
    assert.deepEqual(detail, {
      subject: "TEST Cenová nabídka",
      from: "Jana Nováková <jana@example.test>",
      to: ["Jan <jan@example.test>", "obchod@example.test"],
      at: "2026-10-17T06:30:00.000Z",
      text: "Dobrý den,\n\nposílám nabídku & ceník na rok 2027.\n\nCena: 1 000 Kč\nPlatnost do pátku\n\nS pozdravem,\nJana",
      doc: detail.doc,
      link: "https://outlook.example.test/mail/1",
    });
    assert.equal(detail.doc?.length, 1);
    // The read named the ref: it is learned as the widget's open recipe.
    assert.equal(opened.mode, "agent");
    assert.deepEqual(opened.open, {
      serviceId: opened.open!.serviceId,
      serviceRevision: opened.open!.serviceRevision,
      actionId: messageId,
      actionRevision: opened.open!.actionRevision,
      input: { id: graphMessage.id },
      refPaths: ["id"],
    });
    // Three model calls (discover, read, stop), all with the two tools; the
    // model saw only a small projection of the read, never the whole body.
    assert.equal(collect.length, 3);
    assert.equal(h.catalog.inferenceBudget.summary(runId).calls, 3);
    for (const body of collect)
      assert.deepEqual(body.tools!.map((tool) => tool.function.name).sort(), [
        "find_actions",
        "read",
      ]);
    const instructions = String(
      (collect[0]!.messages![0] as { content: unknown }).content,
    );
    assert.match(instructions, /Read this one message in full/);
    assert.match(instructions, new RegExp(graphMessage.id));
    assert.match(instructions, /At most 2 reads/);
    const outputs = toolOutputs(collect.at(-1)!);
    assert.match(outputs[1]!.note, /untrusted/);
    assert(
      Buffer.byteLength(JSON.stringify(outputs[1]!.untrustedData)) <=
        HUB_OPEN_LIMITS.resultBytes + 200,
    );
    // One read went out, with a durable receipt and no write.
    assert.deepEqual(
      h.serviceRequests.map((request) => request.url),
      [`/v1/messages?id=${encodeURIComponent(graphMessage.id)}`],
    );
    assert.equal(
      Number(
        h.db
          .prepare(
            "SELECT COUNT(*) AS n FROM agent_service_invocation WHERE json_extract(data,'$.status')='succeeded'",
          )
          .get()!.n,
      ),
      1,
    );
  } finally {
    await h.close();
  }
});

test("an open stops at two reads and fails cleanly when no read holds a message", async () => {
  const h = createTrustHarness();
  try {
    const { messageId, readId, open } = setup(h);
    let reads = 0;
    h.onService((request) => {
      if (!request.path.endsWith("/messages")) return undefined;
      reads++;
      return { value: "TEST not a message" };
    });
    // The agent keeps reading: the third read is refused before dispatch.
    h.onChat((body) => {
      const outputs = toolOutputs(body);
      if (!outputs.length)
        return h.call("find_actions", {
          service: "TEST Calendar and contacts",
          need: "messages",
        });
      if (outputs.length < HUB_OPEN_LIMITS.steps)
        return h.call("read", {
          action: messageId,
          input: { id: `TEST-${outputs.length}` },
        });
      return { content: "TEST done" };
    });
    await assert.rejects(open().result, code("hub_open_failed"));
    assert.equal(reads, HUB_OPEN_LIMITS.reads);
    // A read that answered with something else than a message: nothing to show.
    reads = 0;
    h.onChat((body) => {
      const outputs = toolOutputs(body);
      if (!outputs.length)
        return h.call("find_actions", {
          service: "TEST Calendar and contacts",
          need: "contacts",
        });
      if (outputs.length === 1)
        return h.call("read", { action: readId, input: { name: "Jane" } });
      return { content: "TEST done" };
    });
    await assert.rejects(open().result, code("hub_open_failed"));
    // The agent found nothing to read at all.
    h.onChat(() => ({ content: "TEST nothing fits" }));
    await assert.rejects(open().result, code("hub_open_failed"));
    // The widget's sources narrow where it may read; none left is refused.
    await assert.rejects(
      open({ sources: [{ id: randomUUID(), name: "TEST gone" }] }).result,
      code("hub_source_unavailable"),
    );
  } finally {
    await h.close();
  }
});

test("a learned open read is replayed for another item without a model call; a stale one sends the agent again", async () => {
  const h = createTrustHarness();
  try {
    const { messageId, open } = setup(h);
    const second = {
      ...graphMessage,
      id: "AAMkAGE1-TEST-2",
      subject: "TEST Second",
    };
    // The service answers by id, as a real "read message" action does.
    h.onService((request) =>
      request.path.endsWith("/messages")
        ? ([graphMessage, second].find(
            (message) => message.id === request.search.get("id"),
          ) ?? { error: "not_found" })
        : undefined,
    );
    const agent = (body: ModelRequest) => {
      const outputs = toolOutputs(body);
      if (!outputs.length)
        return h.call("find_actions", {
          service: "TEST Calendar and contacts",
          need: "read one message by id",
        });
      if (outputs.length === 1)
        return h.call("read", {
          action: messageId,
          input: {
            id: String(body.messages![1]!.content).includes("TEST-2")
              ? second.id
              : graphMessage.id,
          },
        });
      return { content: "TEST done" };
    };
    h.onChat(agent);
    const first = await open().result;
    const learned = first.open!;
    assert.deepEqual(learned.refPaths, ["id"]);
    const calls = h.requests.length;

    // The other item: the same read with its id put in, no model at all.
    h.onChat(() => {
      throw new Error("TEST the model must not be called on replay");
    });
    h.serviceRequests.length = 0;
    const replayed = await open({
      ref: second.id,
      hint: {
        ...first.detail,
        subject: second.subject,
        receivedAt: "2026-10-17T06:30:00Z",
      },
      open: learned,
    }).result;
    assert.equal(replayed.mode, "replay");
    assert.equal(replayed.open, undefined);
    assert.equal(replayed.detail.subject, "TEST Second");
    assert.equal(h.requests.length, calls);
    assert.deepEqual(
      h.serviceRequests.map((request) => request.url),
      [`/v1/messages?id=${encodeURIComponent(second.id)}`],
    );
    // Background mode replays only; a read that holds no message is a failure.
    await assert.rejects(
      open({ ref: "AAMkAGE1-missing", open: learned, mode: "replay" }).result,
      code("hub_open_failed"),
    );
    // A recipe whose action changed is not replayed: the agent looks again
    // (and learns afresh); in background mode nothing can run.
    const stale: HubOpenRecipe = {
      ...learned,
      actionRevision: learned.actionRevision + 1,
    };
    await assert.rejects(
      open({ ref: second.id, open: stale, mode: "replay" }).result,
      code("hub_open_unavailable"),
    );
    h.onChat(agent);
    const again = await open({ ref: second.id, open: stale }).result;
    assert.equal(again.mode, "agent");
    assert.deepEqual(again.open, { ...learned, input: { id: second.id } });
    assert.equal(h.requests.length, calls + 3);
    // A replay that finds nothing falls back to the agent in the foreground.
    h.serviceRequests.length = 0;
    const fallback = await open({
      ref: "AAMkAGE1-TEST-1",
      open: { ...learned, input: { id: "x" }, refPaths: [] },
    }).result;
    assert.equal(fallback.mode, "agent");
    assert.equal(fallback.detail.subject, "TEST Cenová nabídka");
    // The paths helpers.
    assert.deepEqual(refPaths({ a: "r", b: { c: "r", d: ["r", "x"] } }, "r"), [
      "a",
      "b.c",
      "b.d.0",
    ]);
    assert.deepEqual(
      withRef(
        { a: "r", b: { c: "r", d: ["r", "x"] } },
        ["a", "b.c", "b.d.0"],
        "n",
      ),
      { a: "n", b: { c: "n", d: ["n", "x"] } },
    );
  } finally {
    await h.close();
  }
});

test("a prefetch opens the widget's rows one after the other through the learned read only, bounded, and stops on an authority failure", async () => {
  const h = createTrustHarness();
  try {
    const { messageId, open } = setup(h);
    const served: string[] = [];
    h.onService((request) => {
      if (!request.path.endsWith("/messages")) return undefined;
      const id = request.search.get("id")!;
      served.push(id);
      return id.startsWith("TEST-m")
        ? { ...graphMessage, id, subject: `TEST ${id}` }
        : { error: "not_found" };
    });
    h.onChat((body) => {
      const outputs = toolOutputs(body);
      if (!outputs.length)
        return h.call("find_actions", {
          service: "TEST Calendar and contacts",
          need: "message",
        });
      if (outputs.length === 1)
        return h.call("read", { action: messageId, input: { id: "TEST-m0" } });
      return { content: "TEST done" };
    });
    const learned = (await open({ ref: "TEST-m0" }).result).open!;
    h.onChat(() => {
      throw new Error("TEST a prefetch never calls the model");
    });
    const selected = h.catalog.resolveModel(
      h.target.organizationId,
      h.target.workspaceId,
    )!;
    const access = (runId: string) =>
      createHubFillAccess({
        controller: h.controller,
        context: h.context,
        target: h.target,
        selected,
        userId: h.scope.userId,
        runId,
        check: () => {},
      });
    const refs = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        ref: `TEST-m${index + 1}`,
        hint: { from: "a", subject: "s", receivedAt: "2026-10-17T06:30:00Z" },
      }));
    const base = {
      type: "inbox",
      sources: [],
      recipe: null,
      open: learned,
      language: "cs" as const,
      now: Date.parse("2026-10-17T07:00:00.000Z"),
      runKey: `hub-prefetch/TEST/${randomUUID()}`,
    };
    const kept: string[] = [];
    served.length = 0;
    // More rows than the bound: the first twelve, in order, each stored.
    const result = await runHubPrefetch(
      access(base.runKey),
      { ...base, refs: refs(HUB_PREFETCH_LIMIT + 3) },
      new AbortController().signal,
      async (ref, detail) => {
        assert.equal(detail.subject, `TEST ${ref}`);
        kept.push(ref);
      },
    );
    assert.deepEqual(result, { fetched: HUB_PREFETCH_LIMIT });
    assert.deepEqual(
      kept,
      refs(HUB_PREFETCH_LIMIT).map((row) => row.ref),
    );
    assert.deepEqual(served, kept);
    // One that cannot be read is skipped; the rest still come.
    kept.length = 0;
    const partial = await runHubPrefetch(
      access(base.runKey + "/2"),
      {
        ...base,
        runKey: base.runKey + "/2",
        refs: [{ ref: "TEST-x", hint: refs(1)[0]!.hint }, ...refs(2)],
      },
      new AbortController().signal,
      async (ref) => {
        kept.push(ref);
      },
    );
    assert.deepEqual(partial, { fetched: 2 });
    assert.deepEqual(kept, ["TEST-m1", "TEST-m2"]);
    // Without a usable recipe nothing runs: the person's authority, not a row.
    const stopped = await runHubPrefetch(
      access(base.runKey + "/3"),
      {
        ...base,
        runKey: base.runKey + "/3",
        open: { ...learned, actionRevision: learned.actionRevision + 1 },
        refs: refs(3),
      },
      new AbortController().signal,
      async () => {
        assert.fail("TEST nothing to keep");
      },
    );
    assert.deepEqual(stopped, { fetched: 0, stopped: "hub_open_unavailable" });
  } finally {
    await h.close();
  }
});

test("the index keeps opened details for a day, forgets rows a fill dropped and goes with the item", () => {
  const { db, hub, store, actorOf, add, advance } = hubFixture();
  try {
    const anna = actorOf("TEST-anna");
    const inbox = add("TEST-anna", "inbox");
    const email = (id: string) => ({
      id,
      from: "Jana",
      subject: `TEST ${id}`,
      receivedAt: "2026-10-17T06:30:00Z",
      summary: "TEST",
      importance: "normal" as const,
    });
    const fill = (ids: string[]) =>
      hub.fillDone(anna, inbox, hub.fillRequest(anna, inbox), {
        data: { emails: ids.map(email) },
        recipe: { calls: [], services: ["TEST mail"] },
      });
    fill(["m1", "m2", "m3"]);
    assert.equal(hub.openCached(anna, inbox, "m1"), null);
    const learned: HubOpenRecipe = {
      serviceId: randomUUID(),
      serviceRevision: 1,
      actionId: randomUUID(),
      actionRevision: 2,
      input: { id: "m1" },
      refPaths: ["id"],
    };
    assert.equal(hub.openDone(anna, inbox, "m1", sampleDetail, learned), true);
    assert.equal(
      hub.openDone(anna, inbox, "m2", { ...sampleDetail, subject: "TEST m2" }),
      true,
    );
    // Fresh: served from the index, with its tree; the recipe is the widget's.
    assert.deepEqual(hub.openCached(anna, inbox, "m1"), sampleDetail);
    assert.deepEqual(hub.openRequest(anna, inbox, "m3").open, learned);
    assert.deepEqual(
      store.detail(anna, inbox, "m1", Date.parse("2026-10-17T08:00:00.000Z"))
        ?.recipeRevision,
      2,
    );
    // Nobody else reads it: the index is the person's own.
    assert.equal(hub.openCached(actorOf("TEST-petr"), inbox, "m1"), null);
    // A prefetch opens only what is not fresh.
    assert.deepEqual(
      hub.prefetchRequest(anna, inbox).refs.map((row) => row.ref),
      ["m3"],
    );
    // A fill that drops a row drops its detail; the open recipe survives.
    fill(["m1", "m3"]);
    assert.deepEqual(hub.openCached(anna, inbox, "m1"), sampleDetail);
    assert.equal(hub.openCached(anna, inbox, "m2"), null);
    assert.deepEqual(hub.openRequest(anna, inbox, "m1").open, learned);
    // A changed request drops the recipe, open read included; details stay.
    hub.command(
      anna,
      {
        serverId: "s",
        connectionId: "c",
        workspaceId: anna.workspaceId,
        userId: anna.userId,
      },
      "cs",
      {
        profile: HUB_PROFILE_V3,
        type: "setWidget",
        itemId: inbox,
        brief: "TEST jiné",
      },
    );
    assert.equal(hub.openRequest(anna, inbox, "m1").open, null);
    assert.deepEqual(hub.prefetchRequest(anna, inbox).refs, []);
    // A day later it is stale.
    advance(HUB_DETAIL_TTL_MS - 1);
    assert.deepEqual(hub.openCached(anna, inbox, "m1"), sampleDetail);
    advance(2);
    assert.equal(hub.openCached(anna, inbox, "m1"), null);
    // Only the extracted detail is ever stored, never HTML.
    const rows = db
      .prepare("SELECT detail FROM agent_hub_item_detail WHERE item_id = ?")
      .all(inbox);
    assert.equal(rows.length, 1);
    const stored = JSON.parse(String(rows[0]!.detail)) as Record<
      string,
      unknown
    >;
    assert.deepEqual(Object.keys(stored).sort(), [
      "doc",
      "from",
      "subject",
      "text",
    ]);
    assert(!/<\/?p>/.test(String(rows[0]!.detail)));
    // Removing the item removes its index.
    hub.command(
      anna,
      {
        serverId: "s",
        connectionId: "c",
        workspaceId: anna.workspaceId,
        userId: anna.userId,
      },
      "cs",
      {
        profile: HUB_PROFILE_V3,
        type: "remove",
        itemId: inbox,
      },
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM agent_hub_item_detail").get()!.n,
      0,
    );
    // A removed item takes nothing more.
    assert.equal(hub.openDone(anna, inbox, "m1", sampleDetail), false);
  } finally {
    db.close();
  }
});
