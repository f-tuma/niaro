import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  SkillStore,
  type SkillActor,
} from "../apps/server-identity/skill-store";
import { IdentityError } from "../apps/server-identity/error";
import type { AuditRecord } from "../packages/protocol/audit";
import {
  SKILLS_PROFILE,
  SKILL_LIMITS,
  SkillContentSchema,
  SkillProposalResultSchema,
  type SkillContent,
} from "../packages/protocol/skills";
import { MessageSchema } from "../packages/protocol";

const org = "TEST-org";
const ws = "TEST-ws";
const other = "TEST-ws-2";
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE agent_workspace(id TEXT PRIMARY KEY, organization_id TEXT);
    CREATE TABLE member(id TEXT PRIMARY KEY, "organizationId" TEXT, "userId" TEXT);
    INSERT INTO agent_workspace VALUES ('${ws}','${org}'), ('${other}','${org}');
    INSERT INTO member VALUES ('m-owner','${org}','TEST-owner'), ('m-admin','${org}','TEST-admin'),
      ('m-member','${org}','TEST-member'), ('m-member2','${org}','TEST-member2');`);
  const audit: AuditRecord[] = [];
  const store = new SkillStore(db, (record) => audit.push(record));
  return { db, store, audit };
}
const actor = (
  role: SkillActor["role"],
  userId = `TEST-${role}`,
  workspaceId = ws,
): SkillActor => ({ organizationId: org, workspaceId, userId, role });
const owner = actor("owner"),
  admin = actor("admin"),
  member = actor("member"),
  member2 = actor("member", "TEST-member2");
const content = (name = "TEST nabídky"): SkillContent => ({
  name,
  description: "TEST když píšeš nabídku zákazníkovi",
  instructions: "# Nabídka\n\n1. TEST krok\n2. TEST ceník v příloze",
  files: [{ name: "cenik.csv", content: "položka;cena\nTEST;100\n" }],
});
const save = (
  store: SkillStore,
  who: SkillActor,
  value: SkillContent,
  owner?: "personal" | "workspace",
) =>
  store.command(who, {
    profile: SKILLS_PROFILE,
    type: "save",
    revision: 0,
    ...(owner ? { owner } : {}),
    content: value,
    enabled: true,
  });
const code = (expected: string, status?: number) => (error: unknown) =>
  error instanceof IdentityError &&
  error.code === expected &&
  (status === undefined || error.status === status);

test("who may read and change company and personal skills", () => {
  const { store, audit } = fixture();
  const company = save(store, admin, content("TEST firemní"), "workspace");
  assert.deepEqual(company.owner, { type: "workspace" });
  const mine = save(store, member, content("TEST moje"));
  assert.deepEqual(mine.owner, { type: "user", userId: "TEST-member" });

  // Members cannot create, change or archive company skills.
  assert.throws(
    () => save(store, member, content("TEST pokus"), "workspace"),
    code("skill_forbidden", 403),
  );
  assert.throws(
    () =>
      store.command(member, {
        profile: SKILLS_PROFILE,
        type: "save",
        id: company.id,
        revision: company.revision,
        content: content("TEST změna"),
        enabled: true,
      }),
    code("skill_forbidden", 403),
  );
  assert.throws(
    () =>
      store.command(member, {
        profile: SKILLS_PROFILE,
        type: "archive",
        id: company.id,
        revision: company.revision,
      }),
    code("skill_forbidden", 403),
  );
  // Members read enabled company skills only.
  assert.equal(store.get(member, company.id).name, "TEST firemní");
  const disabled = store.command(owner, {
    profile: SKILLS_PROFILE,
    type: "setEnabled",
    id: company.id,
    revision: company.revision,
    enabled: false,
  });
  assert.equal(disabled.enabled, false);
  assert.throws(
    () => store.get(member, company.id),
    code("skill_not_found", 404),
  );
  assert.deepEqual(store.list(member).workspace, []);
  assert.equal(store.list(admin).workspace.length, 1);
  assert.equal(store.list(admin).canManageWorkspace, true);
  assert.equal(store.list(member).canManageWorkspace, false);

  // Someone else's personal skill does not exist for anyone else, admins included.
  for (const who of [member2, admin, owner])
    assert.throws(() => store.get(who, mine.id), code("skill_not_found", 404));
  assert.throws(
    () =>
      store.command(admin, {
        profile: SKILLS_PROFILE,
        type: "archive",
        id: mine.id,
        revision: mine.revision,
      }),
    code("skill_not_found", 404),
  );
  assert.deepEqual(store.list(member2).personal, []);
  assert.deepEqual(
    store.list(member).personal.map((skill) => skill.name),
    ["TEST moje"],
  );
  // The owner edits their own skill; a stale revision is a conflict.
  const edited = store.command(member, {
    profile: SKILLS_PROFILE,
    type: "save",
    id: mine.id,
    revision: mine.revision,
    content: { ...content("TEST moje"), instructions: "TEST nové kroky" },
    enabled: true,
  });
  assert.equal(edited.revision, 2);
  assert.throws(
    () =>
      store.command(member, {
        profile: SKILLS_PROFILE,
        type: "save",
        id: mine.id,
        revision: 1,
        content: content("TEST moje"),
        enabled: true,
      }),
    code("skill_conflict", 409),
  );
  // The owner never changes.
  assert.throws(
    () =>
      store.command(member, {
        profile: SKILLS_PROFILE,
        type: "save",
        id: mine.id,
        revision: edited.revision,
        owner: "workspace",
        content: content("TEST moje"),
        enabled: true,
      }),
    code("skill_conflict", 409),
  );
  // Another workspace sees nothing of this one.
  assert.throws(
    () => store.get(actor("owner", "TEST-owner", other), company.id),
    code("skill_not_found", 404),
  );
  // Someone outside the organization is refused outright.
  assert.throws(
    () => store.list(actor("member", "TEST-stranger")),
    code("identity_forbidden", 403),
  );

  // Usable: enabled personal first, then enabled company skills.
  const second = save(store, admin, content("TEST zapnutý"), "workspace");
  assert.deepEqual(
    store.usable(member).map((skill) => skill.name),
    ["TEST moje", "TEST zapnutý"],
  );
  assert.equal(store.usableSkill(member, company.id), undefined);
  assert.equal(store.usableSkill(member2, mine.id), undefined);
  assert.equal(store.usableSkill(member, second.id)?.name, "TEST zapnutý");
  assert.equal(store.usableSkill(member, "not a valid id!"), undefined);

  // Archive: gone everywhere.
  store.command(member, {
    profile: SKILLS_PROFILE,
    type: "archive",
    id: mine.id,
    revision: edited.revision,
  });
  assert.throws(() => store.get(member, mine.id), code("skill_not_found", 404));
  assert.deepEqual(store.list(member).personal, []);
  assert.equal(store.usableSkill(member, mine.id), undefined);

  assert.deepEqual(
    audit.map((record) => [
      record.action,
      record.details.skillEvent,
      record.details.skillOwner,
      record.actorId,
    ]),
    [
      ["skill.changed", "created", "workspace", "TEST-admin"],
      ["skill.changed", "created", "personal", "TEST-member"],
      ["skill.changed", "disabled", "workspace", "TEST-owner"],
      ["skill.changed", "updated", "personal", "TEST-member"],
      ["skill.changed", "created", "workspace", "TEST-admin"],
      ["skill.changed", "archived", "personal", "TEST-member"],
    ],
  );
  // The audit never carries skill content.
  assert(!JSON.stringify(audit).includes("TEST krok"));
});

test("limits keep skills small text", () => {
  const ok = content();
  assert(SkillContentSchema.safeParse(ok).success);
  const bad = (change: Partial<SkillContent>) =>
    SkillContentSchema.safeParse({ ...ok, ...change }).success;
  assert.equal(bad({ name: "" }), false);
  assert.equal(bad({ name: "x".repeat(SKILL_LIMITS.name + 1) }), false);
  assert.equal(
    bad({ description: "x".repeat(SKILL_LIMITS.description + 1) }),
    false,
  );
  assert.equal(
    bad({ instructions: "x".repeat(SKILL_LIMITS.instructionsBytes) }),
    true,
  );
  // Bytes, not characters: Czech letters count twice.
  assert.equal(
    bad({ instructions: "č".repeat(SKILL_LIMITS.instructionsBytes / 2 + 1) }),
    false,
  );
  assert.equal(bad({ instructions: "   " }), false);
  // Text files only, no binaries or scripts.
  for (const name of [
    "skript.sh",
    "app.exe",
    "obrazek.png",
    "bez-pripony",
    ".md",
  ])
    assert.equal(bad({ files: [{ name, content: "TEST" }] }), false, name);
  assert.equal(
    bad({ files: [{ name: "data.txt", content: "TEST\u0000binary" }] }),
    false,
  );
  for (const name of ["šablona.md", "Ceník 2026.csv", "data.JSON"])
    assert.equal(bad({ files: [{ name, content: "TEST" }] }), true, name);
  assert.equal(
    bad({
      files: [
        { name: "a.md", content: "x" },
        { name: "A.md", content: "y" },
      ],
    }),
    false,
  );
  assert.equal(
    bad({
      files: Array.from({ length: 6 }, (_, i) => ({
        name: `f${i}.txt`,
        content: "x",
      })),
    }),
    false,
  );
  assert.equal(
    bad({
      files: [
        { name: "big.txt", content: "x".repeat(SKILL_LIMITS.fileBytes + 1) },
      ],
    }),
    false,
  );
  // Each file fits, but together they exceed the total.
  assert.equal(
    bad({
      files: Array.from({ length: 3 }, (_, i) => ({
        name: `f${i}.txt`,
        content: "x".repeat(SKILL_LIMITS.fileBytes),
      })),
    }),
    false,
  );

  const { store } = fixture();
  save(store, member, content("TEST jméno"));
  assert.throws(
    () => save(store, member, content("test JMÉNO")),
    code("skill_name_taken", 409),
  );
  // The same name is fine for someone else and as a company skill.
  save(store, member2, content("TEST jméno"));
  save(store, admin, content("TEST jméno"), "workspace");
  for (let i = 1; i < SKILL_LIMITS.personalPerPerson; i++)
    save(store, member, content(`TEST ${i}`));
  assert.throws(
    () => save(store, member, content("TEST navíc")),
    code("skill_limit", 409),
  );
});

test("a proposal from chat is saved once, by its own person, where they may", () => {
  const { store, audit } = fixture();
  const proposed = store.propose(member, "TEST-proposal-1", content());
  assert.equal(proposed.id, "TEST-proposal-1");
  // A replay with the same content is the same proposal; other content conflicts.
  store.propose(member, "TEST-proposal-1", content());
  assert.throws(
    () => store.propose(member, "TEST-proposal-1", content("TEST jiný")),
    code("skill_conflict", 409),
  );
  assert.throws(
    () => store.propose(member2, "TEST-proposal-1", content()),
    code("skill_conflict", 409),
  );
  assert.deepEqual(store.proposalStatus(member, "TEST-proposal-1"), {
    profile: SKILLS_PROFILE,
    proposalId: "TEST-proposal-1",
    status: "open",
  });
  // Nobody else can see or save it.
  assert.throws(
    () => store.proposalStatus(member2, "TEST-proposal-1"),
    code("skill_proposal_not_found", 404),
  );
  assert.throws(
    () => store.accept(admin, "TEST-proposal-1", "workspace"),
    code("skill_proposal_not_found", 404),
  );
  // A member cannot save it for the company.
  assert.throws(
    () => store.accept(member, "TEST-proposal-1", "workspace"),
    code("skill_forbidden", 403),
  );
  assert.equal(audit.length, 0);
  // A taken name gets a number instead of failing.
  save(store, member, content());
  const saved = store.accept(member, "TEST-proposal-1", "personal");
  assert.equal(saved.status, "saved");
  assert.equal(saved.target, "personal");
  const skill = store.get(member, saved.skillId!);
  assert.equal(skill.name, "TEST nabídky 2");
  assert.deepEqual(skill.files, content().files);
  // Repeating the accept (even with another target) returns the same result.
  assert.deepEqual(store.accept(member, "TEST-proposal-1", "personal"), saved);
  assert.deepEqual(store.accept(member, "TEST-proposal-1", "workspace"), saved);
  assert.equal(store.list(member).personal.length, 2);
  assert.equal(audit.at(-1)?.source, "chat");

  // An administrator saves their own proposal for the company.
  store.propose(admin, "TEST-proposal-2", content("TEST pro firmu"));
  const company = store.accept(admin, "TEST-proposal-2", "workspace");
  assert.equal(company.target, "workspace");
  assert.equal(store.get(member, company.skillId!).owner.type, "workspace");

  // The card is a valid message result.
  const card = SkillProposalResultSchema.parse({
    type: "skill.proposal",
    version: 1,
    proposalId: "TEST-proposal-1",
    name: skill.name,
    description: skill.description,
    preview: skill.instructions,
    files: ["cenik.csv"],
    workspaceAllowed: false,
  });
  assert(
    MessageSchema.safeParse({
      id: "TEST-message",
      role: "assistant",
      text: "TEST",
      result: card,
    }).success,
  );
});

test("an older skills table gains new columns in place and keeps its rows", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE agent_workspace(id TEXT PRIMARY KEY, organization_id TEXT);
    CREATE TABLE member(id TEXT PRIMARY KEY, "organizationId" TEXT, "userId" TEXT);
    INSERT INTO agent_workspace VALUES ('${ws}','${org}');
    INSERT INTO member VALUES ('m-member','${org}','TEST-member');
    CREATE TABLE agent_skill (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      owner_type TEXT NOT NULL, owner_user_id TEXT, name TEXT NOT NULL,
      description TEXT NOT NULL, instructions TEXT NOT NULL, files TEXT NOT NULL,
      revision INTEGER NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO agent_skill VALUES ('TEST-old','${org}','${ws}','user','TEST-member','TEST starý',
      'TEST popis','TEST postup','[]',3,'TEST-member','2026-10-01T00:00:00.000Z','TEST-member','2026-10-01T00:00:00.000Z');`);
  const first = new SkillStore(db);
  const columns = db
    .prepare("PRAGMA table_info(agent_skill)")
    .all()
    .map((column) => column.name);
  assert(columns.includes("enabled") && columns.includes("archived_at"));
  const old = first.get(member, "TEST-old");
  assert.equal(old.enabled, true);
  assert.equal(old.revision, 3);
  // Opening again changes nothing.
  new SkillStore(db);
  assert.deepEqual(new SkillStore(db).get(member, "TEST-old"), old);
  // The owner cannot be rewritten underneath.
  assert.throws(
    () =>
      db
        .prepare(
          "UPDATE agent_skill SET owner_type='workspace', owner_user_id=NULL WHERE id='TEST-old'",
        )
        .run(),
    /skill_owner_immutable/,
  );
});
