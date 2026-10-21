import { z } from "zod";
import { ScopeSchema } from "./index";

/**
 * Search in the person's own chats (`GET /v1/:workspace/search`). It finds
 * chat names, the person's messages and the assistant's final answer of each
 * turn; tool outputs, card data, process journals and the assistant's private
 * transcript are never searched. An older server answers `404`.
 */
export const CHAT_SEARCH_PROFILE = "agent-chat-search/1" as const;

/** Longest query; a longer one is refused, not cut. */
export const CHAT_SEARCH_MAX_QUERY = 200;
/** Chats per page; `limit` defaults to 10. */
export const CHAT_SEARCH_MAX_LIMIT = 20;
/** Best messages per chat on a result. */
export const CHAT_SEARCH_MAX_MATCHES = 3;

/** Which messages count: both (default), the person's or the assistant's. */
export const ChatSearchRoleSchema = z.enum(["user", "assistant"]);
export type ChatSearchRole = z.infer<typeof ChatSearchRoleSchema>;

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9._:-]+$/);

/**
 * Highlighted parts of a text as `[start, end)` UTF-16 offsets (JavaScript
 * string indexes), ordered and not overlapping. Plain text, never markup:
 * clients render the ranges themselves.
 */
export const SearchRangesSchema = z
  .array(
    z
      .tuple([z.number().int().nonnegative(), z.number().int().positive()])
      .refine(([start, end]) => start < end, "Empty range"),
  )
  .max(32)
  .refine(
    (ranges) => ranges.every((r, i) => i === 0 || ranges[i - 1]![1] <= r[0]),
    "Ranges must be ordered and not overlap",
  );
export type SearchRanges = z.infer<typeof SearchRangesSchema>;

export const ChatSearchMatchSchema = z
  .strictObject({
    messageId: id,
    role: ChatSearchRoleSchema,
    /** When the server stored the message; older messages have none. */
    createdAt: z.iso.datetime().optional(),
    /** A short excerpt of the message around the best match. A leading or
     * trailing "…" marks a cut. */
    snippet: z.string().min(1).max(400),
    ranges: SearchRangesSchema,
  })
  .refine(
    (match) => match.ranges.every(([, end]) => end <= match.snippet.length),
    "Range outside the snippet",
  );
export type ChatSearchMatch = z.infer<typeof ChatSearchMatchSchema>;

export const ChatSearchResultSchema = z
  .strictObject({
    conversation: z.strictObject({
      id,
      /** The chat's shown name (the person's name or the first request);
       * empty for a chat without one, e.g. a hub item's chat. */
      title: z.string().max(160),
      updatedAt: z.iso.datetime(),
      /** Read-only and listed in the archive (`readOnly` in the directory). */
      archived: z.boolean(),
    }),
    /** Matches in the title, when the title matched. */
    titleRanges: SearchRangesSchema,
    /** The best matching messages, best first. */
    matches: z.array(ChatSearchMatchSchema).max(CHAT_SEARCH_MAX_MATCHES),
    /** How many of the chat's messages matched in all. */
    matchCount: z.number().int().nonnegative(),
  })
  .refine(
    (result) =>
      result.titleRanges.every(
        ([, end]) => end <= result.conversation.title.length,
      ),
    "Range outside the title",
  )
  .refine(
    (result) => result.titleRanges.length > 0 || result.matches.length > 0,
    "A result matches somewhere",
  );
export type ChatSearchResult = z.infer<typeof ChatSearchResultSchema>;

/** One page of chats, best first; `nextAfter` reads the next page. */
export const ChatSearchPageSchema = z
  .strictObject({
    profile: z.literal(CHAT_SEARCH_PROFILE),
    scope: ScopeSchema,
    results: z.array(ChatSearchResultSchema).max(CHAT_SEARCH_MAX_LIMIT),
    nextAfter: z
      .string()
      .regex(/^[1-9][0-9]{0,5}$/)
      .nullable(),
  })
  .refine(
    (page) =>
      new Set(page.results.map((r) => r.conversation.id)).size ===
      page.results.length,
    "A chat appears once on a page",
  );
export type ChatSearchPage = z.infer<typeof ChatSearchPageSchema>;

/** What a search asks for besides the words. */
export type ChatSearchOptions = {
  after?: string | null;
  limit?: number;
  /** Also search archived chats. */
  includeArchived?: boolean;
  /** Only archived chats (implies `includeArchived`). */
  archivedOnly?: boolean;
  /** Only the person's messages or only the assistant's answers (titles
   * then don't count). */
  role?: ChatSearchRole;
};

/** The request path below `/v1/:workspace/`. */
export function chatSearchPath(query: string, options: ChatSearchOptions = {}) {
  const params = new URLSearchParams({
    profile: CHAT_SEARCH_PROFILE,
    q: query,
  });
  if (options.after) params.set("after", options.after);
  if (options.limit) params.set("limit", String(options.limit));
  if (options.archivedOnly) params.set("state", "archived");
  else if (options.includeArchived) params.set("include", "archived");
  if (options.role) params.set("role", options.role);
  return `search?${params.toString()}`;
}
