import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SKILLS_PROFILE,
  SkillListSchema,
  SkillProposalStatusSchema,
  SkillSchema,
} from "../packages/protocol/skills";
import { MentionDirectorySchema } from "../packages/protocol/mentions";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";

const content = (name: string) => ({
  name,
  description: "TEST když píšeš nabídku",
  instructions: "# TEST\n\nPostup nabídky.",
  files: [{ name: "cenik.csv", content: "TEST;100" }],
});

test(
  "skills over the console API and the app API, and what a person can tag",
  { timeout: 120000 },
  async () => {
    const h = await coordinatorHttpFixture();
    try {
      const skills = (
        role: "owner" | "admin" | "member" | "anonymous",
        route: "list" | "get" | "command",
        body: Record<string, unknown> = {},
      ) =>
        h.request(role, `api/identity/skills/${route}`, {
          ...h.target,
          ...body,
        });
      const ok = (response: { status: number; data: unknown }) => {
        assert.equal(response.status, 200, JSON.stringify(response.data));
        return response.data;
      };
      const create = (
        role: "owner" | "admin" | "member",
        name: string,
        owner?: "personal" | "workspace",
      ) =>
        skills(role, "command", {
          profile: SKILLS_PROFILE,
          type: "save",
          revision: 0,
          ...(owner ? { owner } : {}),
          content: content(name),
          enabled: true,
        });

      assert.equal((await skills("anonymous", "list")).status, 401);
      const company = SkillSchema.parse(
        ok(await create("admin", "TEST firemní", "workspace")),
      );
      assert.deepEqual(company.owner, { type: "workspace" });
      const hidden = SkillSchema.parse(
        ok(await create("owner", "TEST vypnutý", "workspace")),
      );
      ok(
        await skills("owner", "command", {
          profile: SKILLS_PROFILE,
          type: "setEnabled",
          id: hidden.id,
          revision: hidden.revision,
          enabled: false,
        }),
      );
      const refused = await create("member", "TEST pokus", "workspace");
      assert.equal(refused.status, 403);
      assert.deepEqual(refused.data, { error: "skill_forbidden" });
      const mine = SkillSchema.parse(ok(await create("member", "TEST moje")));
      assert.equal(mine.owner.type, "user");
      // An invalid skill is refused before anything is stored.
      assert.equal(
        (
          await skills("member", "command", {
            profile: SKILLS_PROFILE,
            type: "save",
            revision: 0,
            content: {
              ...content("TEST špatný"),
              files: [{ name: "x.exe", content: "MZ" }],
            },
            enabled: true,
          })
        ).status,
        400,
      );

      const memberList = SkillListSchema.parse(
        ok(await skills("member", "list")),
      );
      assert.deepEqual(
        memberList.personal.map((skill) => skill.name),
        ["TEST moje"],
      );
      assert.deepEqual(
        memberList.workspace.map((skill) => skill.name),
        ["TEST firemní"],
      );
      assert.equal(memberList.canManageWorkspace, false);
      const adminList = SkillListSchema.parse(
        ok(await skills("admin", "list")),
      );
      assert.deepEqual(adminList.personal, []);
      assert.equal(adminList.workspace.length, 2);
      // Someone else's personal skill is not there for an administrator.
      assert.equal((await skills("admin", "get", { id: mine.id })).status, 404);
      assert.equal(
        SkillSchema.parse(ok(await skills("member", "get", { id: mine.id })))
          .instructions,
        mine.instructions,
      );
      assert.equal(
        (await skills("member", "get", { id: hidden.id })).status,
        404,
      );

      // The app API: the same person's usable skills, read-only.
      const member = await h.pair("member");
      const admin = await h.pair("admin");
      assert.equal((await h.mobile(undefined, "skills")).status, 401);
      assert.equal((await h.mobile(member, "skills?extra=1")).status, 400);
      const appList = SkillListSchema.parse(
        ok(await h.mobile(member, "skills")),
      );
      assert.deepEqual(
        [...appList.personal, ...appList.workspace].map((skill) => skill.name),
        ["TEST moje", "TEST firemní"],
      );
      assert.equal(
        SkillSchema.parse(ok(await h.mobile(member, `skills?id=${mine.id}`)))
          .name,
        "TEST moje",
      );
      assert.equal((await h.mobile(admin, `skills?id=${mine.id}`)).status, 404);
      // Only accept is a command here; editing stays in the editors.
      assert.equal(
        (
          await h.mobile(member, "skills", {
            profile: SKILLS_PROFILE,
            type: "save",
          })
        ).status,
        400,
      );

      // A proposal from chat is saved by an authenticated, repeatable accept.
      const store = h.identity["skills"];
      const memberActor = {
        ...h.target,
        userId: member.scope.userId,
        role: "member" as const,
      };
      store.propose(memberActor, "TEST-proposal", content("TEST z chatu"));
      const accept = (credential: typeof member, target: string) =>
        h.mobile(credential, "skills", {
          profile: SKILLS_PROFILE,
          type: "accept",
          proposalId: "TEST-proposal",
          target,
        });
      assert.equal(
        SkillProposalStatusSchema.parse(
          ok(await h.mobile(member, "skills?proposalId=TEST-proposal")),
        ).status,
        "open",
      );
      assert.equal((await accept(admin, "personal")).status, 404);
      assert.equal((await accept(member, "workspace")).status, 403);
      const saved = SkillProposalStatusSchema.parse(
        ok(await accept(member, "personal")),
      );
      assert.equal(saved.status, "saved");
      assert.deepEqual(
        SkillProposalStatusSchema.parse(ok(await accept(member, "personal"))),
        saved,
      );
      assert.equal(
        SkillSchema.parse(
          ok(await h.mobile(member, `skills?id=${saved.skillId}`)),
        ).name,
        "TEST z chatu",
      );

      // Mentions: services with an allowed action, ready processes, usable skills.
      const process = h.activate();
      assert.equal((await h.mobile(undefined, "mentions")).status, 401);
      assert.equal((await h.mobile(member, "mentions?x=1")).status, 400);
      const directory = MentionDirectorySchema.parse(
        ok(await h.mobile(member, "mentions")),
      );
      const kinds = (kind: string) =>
        directory.items
          .filter((item) => item.kind === kind)
          .map((item) => item.id);
      assert.deepEqual(kinds("service"), [h.serviceId]);
      assert.deepEqual(kinds("process"), [process.processId]);
      assert.deepEqual(
        directory.items
          .filter((item) => item.kind === "skill")
          .map((item) => [item.name, item.personal ?? false]),
        [
          ["TEST moje", true],
          ["TEST z chatu", true],
          ["TEST firemní", false],
        ],
      );
      // The administrator does not see the member's personal skills.
      const adminDirectory = MentionDirectorySchema.parse(
        ok(await h.mobile(admin, "mentions")),
      );
      assert.deepEqual(
        adminDirectory.items
          .filter((item) => item.kind === "skill")
          .map((item) => item.name),
        ["TEST firemní"],
      );
      // Archiving removes it from tagging at once.
      ok(
        await skills("member", "command", {
          profile: SKILLS_PROFILE,
          type: "archive",
          id: mine.id,
          revision: mine.revision,
        }),
      );
      assert(
        !MentionDirectorySchema.parse(
          ok(await h.mobile(member, "mentions")),
        ).items.some((item) => item.id === mine.id),
      );
      assert.deepEqual(h.dispatches, []);
    } finally {
      await h.close();
    }
  },
);
