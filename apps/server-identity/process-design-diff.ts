import type { ProcessDefinition } from "../../packages/protocol/service-processes";
import type { DesignReview } from "../../packages/protocol/process-design";
import { processDigest } from "./process-validation";

/** Stable step IDs prevent a reorder from disguising an edited capability or binding. */
export function processDesignDiff(
  before: ProcessDefinition | null,
  after: ProcessDefinition | null,
) {
  const changes: DesignReview["changes"] = [];
  let changesTruncated = false;
  const preview = (value: unknown) => {
    if (value === undefined) return null;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text.length <= 2000) return text;
    changesTruncated = true;
    return text.slice(0, 1999) + "…";
  };
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  const walk = (left: unknown, right: unknown, path: string) => {
    if (left === right) return;
    if (
      left !== undefined &&
      right !== undefined &&
      processDigest(left) === processDigest(right)
    )
      return;
    if (
      (object(left) && (object(right) || right === undefined)) ||
      (object(right) && left === undefined)
    ) {
      const l = object(left) ? left : {},
        r = object(right) ? right : {};
      for (const key of [
        ...new Set([...Object.keys(l), ...Object.keys(r)]),
      ].sort())
        walk(
          l[key],
          r[key],
          path + "/" + key.replaceAll("~", "~0").replaceAll("/", "~1"),
        );
      return;
    }
    if (
      path === "/steps" &&
      (Array.isArray(left) || left === undefined) &&
      (Array.isArray(right) || right === undefined)
    ) {
      const byId = (items: unknown[]) =>
        new Map(items.filter(object).map((item) => [String(item.id), item]));
      const l = byId(left ?? []),
        r = byId(right ?? []);
      for (const id of [...new Set([...l.keys(), ...r.keys()])].sort())
        walk(l.get(id), r.get(id), path + "/" + id);
      return;
    }
    if (changes.length === 200) {
      changesTruncated = true;
      return;
    }
    changes.push({
      path: path || "/",
      kind:
        left === undefined
          ? "added"
          : right === undefined
            ? "removed"
            : "changed",
      before: preview(left),
      after: preview(right),
    });
  };
  walk(before ?? undefined, after ?? undefined, "");
  return { changes, changesTruncated };
}
