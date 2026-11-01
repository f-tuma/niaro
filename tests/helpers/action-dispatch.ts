import type { ModelMessage } from "../../apps/server-integrations/models";

/** How the chat runtime lists the actions call_action can run (runtime.ts). */
const LISTING = "Actions ready to run with call_action";

type DispatchedRequest = {
  messages?: ModelMessage[];
  tools?: {
    type?: string;
    function: { name: string; description?: string; parameters?: unknown };
  }[];
};

/**
 * The chat sends service actions to the provider through one call_action tool,
 * with their schemas as text. Scripted models written against native action
 * tools see the request as before: the listed actions as tools, their earlier
 * calls under their own names, and no listing message. The dispatch itself is
 * covered by its own tests.
 */
export function nativeActionView<T extends DispatchedRequest>(body: T): T {
  if (!body.tools?.some((tool) => tool.function.name === "call_action"))
    return body;
  const listing = body.messages?.find(
    (message) =>
      message.role === "system" &&
      typeof message.content === "string" &&
      message.content.startsWith(LISTING),
  );
  const actions = listing
    ? String(listing.content)
        .split("\n")
        .slice(1)
        .map(
          (line) =>
            JSON.parse(line) as {
              action: string;
              description: string;
              input: unknown;
            },
        )
    : [];
  return {
    ...body,
    tools: [
      ...body.tools.filter((tool) => tool.function.name !== "call_action"),
      ...actions.map((action) => ({
        type: "function",
        function: {
          name: action.action,
          description: action.description,
          parameters: action.input,
        },
      })),
    ],
    messages: body.messages
      ?.filter((message) => message !== listing)
      .map((message) =>
        message.tool_calls
          ? {
              ...message,
              tool_calls: message.tool_calls.map((call) => {
                if (call.function.name !== "call_action") return call;
                const { action, input } = JSON.parse(
                  call.function.arguments,
                ) as {
                  action: string;
                  input: unknown;
                };
                return {
                  ...call,
                  function: { name: action, arguments: JSON.stringify(input) },
                };
              }),
            }
          : message,
      ),
  };
}
