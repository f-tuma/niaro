/** Explicit local-only smoke test: npm run test:mailpit. Never sends external email. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { Invitations } from "../apps/server-identity/invitations";
async function main() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `PRAGMA foreign_keys=ON;CREATE TABLE user(id TEXT PRIMARY KEY);CREATE TABLE agent_workspace(id TEXT PRIMARY KEY,name TEXT,organization_id TEXT);CREATE TABLE member(id TEXT,"userId" TEXT,"organizationId" TEXT,role TEXT);INSERT INTO user VALUES ('test-owner');INSERT INTO member VALUES('m','test-owner','o','owner');INSERT INTO agent_workspace VALUES ('w','TEST Mailpit workspace','o');`,
  );
  try {
    const store = new Invitations(db, {
      host: "127.0.0.1",
      port: 1025,
      secure: false,
      starttls: false,
      from: "assistant@localhost.test",
    });
    const email = `test-${randomUUID()}@example.test`;
    await store.send("w", email, "test-owner", "http://localhost:8793");
    const page = (await fetch("http://127.0.0.1:8025/api/v1/messages").then(
      (r) => r.json(),
    )) as { messages: { ID: string; To: { Address: string }[] }[] };
    const row = page.messages.find((m) =>
      m.To.some((t) => t.Address === email),
    );
    assert(row, "Mailpit did not receive the invitation");
    const mail = (await fetch(
      `http://127.0.0.1:8025/api/v1/message/${row.ID}`,
    ).then((r) => r.json())) as { Text: string };
    const token = mail.Text.match(/\/account\/invite#([A-Za-z0-9_-]{43})/)?.[1];
    assert(token);
    assert.equal(store.inspect(token).email, email);
    console.log(
      "PASS: invitation delivered through SMTP to local Mailpit; one-use URL verified.",
    );
  } finally {
    db.close();
  }
}
void main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
