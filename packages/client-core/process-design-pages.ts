/** Read bounded cursor pages used by the service-scoped mobile designer. */
export async function readProcessDesignPages<T>(
  read: (after?: string) => Promise<unknown>,
  parse: (raw: unknown) => { items: T[]; nextAfter: string | null },
) {
  const items: T[] = [];
  const cursors = new Set<string>();
  let after: string | undefined;
  do {
    const page = parse(await read(after));
    items.push(...page.items);
    if (items.length > 1000) throw new Error("process_design_history_limit");
    after = page.nextAfter ?? undefined;
    if (after) {
      if (cursors.has(after) || cursors.size >= 10)
        throw new Error("process_design_history_cursor_invalid");
      cursors.add(after);
    }
  } while (after);
  return items;
}
