import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InstructionsAdminViewSchema,
  WorkspaceChatSetupSchema,
} from "../packages/protocol/workspace-instructions";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";

test(
  "workspace instructions over the console API and the app API",
  { timeout: 120000 },
  async () => {
    const h = await coordinatorHttpFixture();
    try {
      const call = (
        role: "owner" | "admin" | "member" | "anonymous",
        route: "get" | "command" | "effective",
        body: Record<string, unknown>,
      ) => h.request(role, `api/identity/instructions/${route}`, body);
      const ok = (response: { status: number; data: unknown }) => {
        assert.equal(response.status, 200, JSON.stringify(response.data));
        return response.data;
      };
      const { organizationId, workspaceId } = h.target;
      const workspace = { type: "workspace", workspaceId };
      const organization = { type: "organization" };

      assert.equal(
        (await call("anonymous", "get", { organizationId, scope: workspace }))
          .status,
        401,
      );
      // Members neither open the editor nor save.
      assert.deepEqual(
        (await call("member", "get", { organizationId, scope: workspace }))
          .data,
        { error: "instructions_forbidden" },
      );
      assert.equal(
        (
          await call("member", "command", {
            organizationId,
            type: "save",
            scope: workspace,
            revision: 0,
            content: { text: "TEST", starters: [] },
          })
        ).status,
        403,
      );
      ok(
        await call("owner", "command", {
          organizationId,
          type: "save",
          scope: organization,
          revision: 0,
          content: {
            text: "TEST výchozí pro {company.name}",
            starters: ["TEST Co mám dnes?"],
          },
        }),
      );
      ok(
        await call("admin", "command", {
          organizationId,
          type: "save",
          scope: workspace,
          revision: 0,
          content: { text: "TEST prostor", starters: [] },
        }),
      );
      // A stale save is a conflict; too long a text is invalid input.
      assert.deepEqual(
        (
          await call("owner", "command", {
            organizationId,
            type: "save",
            scope: workspace,
            revision: 0,
            content: { text: "TEST staré", starters: [] },
          })
        ).data,
        { error: "instructions_conflict" },
      );
      // The full 8,000 characters fit even in Czech (two bytes each).
      ok(
        await call("owner", "command", {
          organizationId,
          type: "save",
          scope: workspace,
          revision: 1,
          content: { text: "ř".repeat(8000), starters: [] },
        }),
      );
      assert.equal(
        (
          await call("owner", "command", {
            organizationId,
            type: "save",
            scope: workspace,
            revision: 2,
            content: { text: "x".repeat(8001), starters: [] },
          })
        ).status,
        400,
      );
      ok(
        await call("owner", "command", {
          organizationId,
          type: "restore",
          scope: workspace,
          revision: 2,
          version: 1,
        }),
      );
      const view = InstructionsAdminViewSchema.parse(
        ok(await call("owner", "get", { organizationId, scope: workspace })),
      );
      assert.equal(view.revision, 3);
      assert.equal(view.content.text, "TEST prostor");
      assert.equal(view.history.length, 3);
      assert.deepEqual(view.organizationDefault?.starters, [
        "TEST Co mám dnes?",
      ]);

      // Everyone in the workspace reads what applies, in the browser and the app.
      const effective = WorkspaceChatSetupSchema.parse(
        ok(await call("member", "effective", { ...h.target })),
      );
      assert.deepEqual(effective.instructions, {
        text: "TEST prostor",
        source: "workspace",
      });
      assert.deepEqual(effective.starters, ["TEST Co mám dnes?"]);
      const member = await h.pair("member");
      assert.equal((await h.mobile(undefined, "instructions")).status, 401);
      assert.equal((await h.mobile(member, "instructions?x=1")).status, 400);
      assert.deepEqual(
        WorkspaceChatSetupSchema.parse(
          ok(await h.mobile(member, "instructions")),
        ),
        effective,
      );

      // The chat's system context reads the same, with the person's own values.
      const prompt = h.identity["catalog"].promptContext!({
        ...h.target,
        userId: member.scope.userId,
      });
      assert.deepEqual(prompt.instructions, effective.instructions);
      assert.equal(typeof prompt.variables.companyName, "string");
      assert.equal(typeof prompt.variables.workspaceName, "string");
      assert.equal(prompt.variables.personRole, "");

      // The typed bundle read/write keeps the same revision rules.
      const bundle = h.identity.readInstructions(organizationId, null);
      assert.equal(bundle.revision, 1);
      assert.equal(bundle.content.text, "TEST výchozí pro {company.name}");
      assert.deepEqual(h.dispatches, []);
    } finally {
      await h.close();
    }
  },
);
