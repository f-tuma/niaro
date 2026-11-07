/**
 * A tiny OpenAI-compatible /chat/completions server (streaming SSE) that
 * records what each request carried: path, model, auth header names, custom
 * headers and the tool list. First turn of a conversation answers with a tool
 * call, a turn that ends in a tool result answers with text.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";

export type Recorded = {
  path: string;
  model: string;
  authorization?: string;
  apiKeyHeader?: string;
  customHeader?: string;
  tools: string[];
  lastRole: string;
  maxTokens?: number;
};

const read = (req: IncomingMessage) =>
  new Promise<string>((ok) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => ok(body));
  });

export async function startStub(): Promise<{ url: (prefix: string) => string; requests: Recorded[]; close(): Promise<void> }> {
  const requests: Recorded[] = [];
  const server: Server = createServer(async (req, res) => {
    const body = JSON.parse((await read(req)) || "{}");
    const messages = body.messages ?? [];
    const last = messages[messages.length - 1] ?? {};
    requests.push({
      path: req.url ?? "",
      model: body.model,
      authorization: req.headers.authorization as string | undefined,
      apiKeyHeader: req.headers["api-key"] as string | undefined,
      customHeader: req.headers["x-niaro-workspace"] as string | undefined,
      tools: (body.tools ?? []).map((t: any) => t.function?.name),
      lastRole: last.role,
      maxTokens: body.max_completion_tokens ?? body.max_tokens,
    });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish: string | null = null, usage?: object) =>
      res.write(
        `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`,
      );
    if (last.role === "tool") {
      chunk({ role: "assistant", content: `Stub answer from ${body.model}: ` });
      chunk({ content: String(last.content).slice(0, 60) });
      chunk({}, "stop", { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 });
    } else {
      chunk({
        role: "assistant",
        tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: "lookup_contact", arguments: "" } }],
      });
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"name":"Ada"}' } }] });
      chunk({}, "tool_calls", { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  return {
    url: (prefix) => `http://127.0.0.1:${port}${prefix}`,
    requests,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}
