import { ClientSession } from "../packages/client-core/session";
import { CHAT_SEARCH_PROFILE } from "../packages/protocol/chat-search";
import { credential, authInfo } from "./auth-fixtures";

const response = (value: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(value),
  }) as Response;

function setup(answer: (url: URL) => Response) {
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async (url) => {
      if (String(url).endsWith("auth/session")) return response(authInfo());
      return answer(new URL(String(url)));
    },
  );
  const storage = new Map<string, string>();
  const session = new ClientSession(
    "https://fixture/v1/a",
    {
      getItem: async (key) => storage.get(key) ?? null,
      setItem: async (key, value) => {
        storage.set(key, value);
      },
    },
    credential(),
    fetcher,
  );
  return { session, fetcher };
}

const page = (scope = credential().scope) => ({
  profile: CHAT_SEARCH_PROFILE,
  scope,
  results: [
    {
      conversation: {
        id: "chat-1",
        title: "Schůzka s Petrem",
        updatedAt: "2026-10-17T08:00:00.000Z",
        archived: false,
      },
      titleRanges: [[0, 7]],
      matches: [
        {
          messageId: "m-1",
          role: "user",
          snippet: "Naplánuj schůzku",
          ranges: [[9, 16]],
        },
      ],
      matchCount: 1,
    },
  ],
  nextAfter: "10",
});

test("searchConversations asks the search route with its filters and checks the answer", async () => {
  const { session, fetcher } = setup(() => response(page()));
  const result = await session.searchConversations(" schůzka ", {
    role: "user",
    includeArchived: true,
    after: "10",
    limit: 5,
  });
  expect(result.results[0]!.conversation.id).toBe("chat-1");
  const url = new URL(String(fetcher.mock.calls.at(-1)![0]));
  expect(url.pathname).toBe("/v1/a/search");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    profile: CHAT_SEARCH_PROFILE,
    q: "schůzka",
    after: "10",
    limit: "5",
    include: "archived",
    role: "user",
  });
});

test("searchConversations reports an older server, limits and foreign answers", async () => {
  await expect(
    setup(() =>
      response({ error: "not_found" }, 404),
    ).session.searchConversations("x"),
  ).rejects.toThrow("chat_search_unavailable");
  await expect(
    setup(() =>
      response({ error: "chat_search_rate_limited" }, 429),
    ).session.searchConversations("x"),
  ).rejects.toThrow("chat_search_rate_limited");
  await expect(
    setup(() =>
      response(page({ ...credential().scope, userId: "mallory" })),
    ).session.searchConversations("x"),
  ).rejects.toThrow("scope_mismatch");
  // Ranges are offsets into plain text and must stay inside it.
  const broken = page();
  broken.results[0]!.matches[0]!.ranges = [[9, 99]];
  await expect(
    setup(() => response(broken)).session.searchConversations("x"),
  ).rejects.toThrow();
});
