import assert from "node:assert/strict";
import { test } from "node:test";
import { KnowledgeAdminView } from "../packages/protocol/knowledge";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";

test(
  "workspace knowledge over the console API: administrators only, off without an embedding model",
  { timeout: 120000 },
  async () => {
    const h = await coordinatorHttpFixture();
    try {
      const call = (
        role: "owner" | "admin" | "member" | "anonymous",
        route: "get" | "command",
        body: Record<string, unknown>,
      ) => h.request(role, `api/identity/knowledge/${route}`, body);
      const { organizationId, workspaceId } = h.target;
      assert.equal(
        (await call("anonymous", "get", { organizationId, workspaceId }))
          .status,
        401,
      );
      // Members neither read the settings nor rebuild.
      assert.equal(
        (await call("member", "get", { organizationId, workspaceId })).status,
        403,
      );
      assert.equal(
        (
          await call("member", "command", {
            organizationId,
            workspaceId,
            type: "rebuild",
          })
        ).status,
        403,
      );
      const first = await call("owner", "get", { organizationId, workspaceId });
      assert.equal(first.status, 200, JSON.stringify(first.data));
      const view = KnowledgeAdminView.parse(first.data);
      // No embedding model: no index; files on, no source picked.
      assert.equal(view.status.state, "off");
      assert.equal(view.revision, 0);
      assert.equal(view.settings.files, true);
      assert.deepEqual(view.settings.sources, []);
      // A source must be a shared read action without input.
      const refused = await call("admin", "command", {
        organizationId,
        workspaceId,
        type: "save",
        revision: 0,
        settings: {
          files: true,
          sources: [{ serviceId: h.serviceId, actionId: "TEST-missing" }],
          chunking: { size: 1200, overlap: 150 },
        },
      });
      assert.equal(refused.status, 409);
      assert.deepEqual(refused.data, { error: "knowledge_source_unavailable" });
      const saved = await call("admin", "command", {
        organizationId,
        workspaceId,
        type: "save",
        revision: 0,
        settings: {
          files: false,
          sources: [],
          chunking: { size: 800, overlap: 100 },
        },
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.data));
      assert.equal(KnowledgeAdminView.parse(saved.data).revision, 1);
      // A stale save conflicts; a bad overlap is invalid input.
      assert.deepEqual(
        (
          await call("owner", "command", {
            organizationId,
            workspaceId,
            type: "save",
            revision: 0,
            settings: { files: true, sources: [] },
          })
        ).data,
        { error: "knowledge_conflict" },
      );
      assert.equal(
        (
          await call("owner", "command", {
            organizationId,
            workspaceId,
            type: "save",
            revision: 1,
            settings: {
              files: true,
              sources: [],
              chunking: { size: 400, overlap: 300 },
            },
          })
        ).status,
        400,
      );
      const rebuilt = await call("owner", "command", {
        organizationId,
        workspaceId,
        type: "rebuild",
      });
      assert.equal(rebuilt.status, 200, JSON.stringify(rebuilt.data));
      await h.identity.knowledgeIdle();
      const after = KnowledgeAdminView.parse(
        (await call("owner", "get", { organizationId, workspaceId })).data,
      );
      assert.equal(after.status.state, "off");
      assert.equal(after.status.chunks, 0);
      assert.equal(after.settings.chunking.size, 800);
    } finally {
      await h.close();
    }
  },
);
