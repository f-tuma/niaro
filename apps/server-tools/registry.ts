import { z } from "zod";
import type { AdminTool } from "../../packages/protocol/admin";
import { ScopeSchema, type Scope } from "../../packages/protocol";

export type ToolPermission = "contacts.read.test";
/** Created by authenticated server code, never deserialized from a model or client. */
export type ToolContext = {
  scope: Scope;
  permissions: ReadonlySet<ToolPermission>;
  signal: AbortSignal;
  validateSession(): void | Promise<void>;
};
export class ToolError extends Error {
  constructor(
    readonly code:
      | "tool_unavailable"
      | "tool_forbidden"
      | "tool_invalid_input"
      | "tool_failed",
  ) {
    super(code);
  }
}
type Definition<I, O> = {
  description?: AdminTool["description"];
  permission: ToolPermission;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  execute(input: I, context: ToolContext): Promise<O>;
};

/** Server-owned allowlist. No dynamic code, URLs, credentials or writes in the tool contract. */
export class ToolRegistry {
  private descriptions = new Map<string, AdminTool>();
  describe(): AdminTool[] {
    return structuredClone([...this.descriptions.values()]);
  }
  private tools = new Map<
    string,
    (raw: unknown, context: ToolContext) => Promise<unknown>
  >();
  register<I, O>(name: string, definition: Definition<I, O>) {
    if (this.tools.has(name)) throw new Error("Duplicate server tool");
    this.descriptions.set(name, {
      id: name,
      permission: definition.permission,
      effect: "read",
      description: definition.description ?? { en: name, cs: name },
    });
    this.tools.set(name, async (raw, context) => {
      ScopeSchema.parse(context.scope);
      context.signal.throwIfAborted();
      await context.validateSession();
      context.signal.throwIfAborted();
      if (!context.permissions.has(definition.permission))
        throw new ToolError("tool_forbidden");
      const input = definition.input.safeParse(raw);
      if (!input.success) throw new ToolError("tool_invalid_input");
      let result: O;
      try {
        result = definition.output.parse(
          await definition.execute(input.data, context),
        );
      } catch {
        throw new ToolError("tool_failed");
      }
      context.signal.throwIfAborted();
      await context.validateSession();
      context.signal.throwIfAborted();
      return result;
    });
  }
  has(name: string) {
    return this.tools.has(name);
  }
  async invoke(
    name: string,
    input: unknown,
    context: ToolContext,
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolError("tool_unavailable");
    return tool(input, context);
  }
}
