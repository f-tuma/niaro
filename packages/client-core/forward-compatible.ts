import type { z } from "zod";
import {
  MEETING_RECORD_PROFILE,
  MeetingRecordSchema,
} from "../protocol/meeting-record";

/**
 * Reading what a newer server sends. The protocol schemas are strict
 * because the server validates requests and stored data with them; an
 * installed app must still read an answer that gained a field. Unknown
 * keys are dropped at any depth before the strict parse, so a known field
 * with a wrong shape still fails as before.
 */
type Def = {
  type: string;
  shape?: Record<string, z.ZodType>;
  catchall?: z.ZodType;
  element?: z.ZodType;
  innerType?: z.ZodType;
  options?: z.ZodType[];
  valueType?: z.ZodType;
  in?: z.ZodType;
  getter?: () => z.ZodType;
};
const definition = (schema: z.ZodType) =>
  (schema as unknown as { _zod: { def: Def } })._zod.def;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** `value` without the keys `schema` does not know, at any depth. */
export function withoutUnknownKeys(schema: z.ZodType, value: unknown): unknown {
  const def = definition(schema);
  switch (def.type) {
    case "object": {
      if (!isRecord(value)) return value;
      // A loose object keeps its extra keys; a strict or plain one drops them.
      const open = !!def.catchall && definition(def.catchall).type !== "never";
      const kept: Record<string, unknown> = open ? { ...value } : {};
      for (const [key, field] of Object.entries(def.shape ?? {}))
        if (Object.hasOwn(value, key))
          kept[key] = withoutUnknownKeys(field, value[key]);
      return kept;
    }
    case "array":
      return Array.isArray(value)
        ? value.map((item) => withoutUnknownKeys(def.element!, item))
        : value;
    case "record":
      return isRecord(value)
        ? Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
              key,
              withoutUnknownKeys(def.valueType!, item),
            ]),
          )
        : value;
    case "union":
      // The first option the stripped value fits; else unchanged, to fail as before.
      for (const option of def.options ?? []) {
        const candidate = withoutUnknownKeys(option, value);
        if (option.safeParse(candidate).success) return candidate;
      }
      return value;
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "nonoptional":
    case "catch":
    case "readonly":
      return withoutUnknownKeys(def.innerType!, value);
    case "pipe":
      return withoutUnknownKeys(def.in!, value);
    case "lazy":
      return withoutUnknownKeys(def.getter!(), value);
    default:
      return value;
  }
}

/** A server answer parsed with `schema`, ignoring fields this build does not know. */
export function parseServerValue<T extends z.ZodType>(
  schema: T,
  value: unknown,
): z.output<T> {
  return schema.parse(withoutUnknownKeys(schema, value)) as z.output<T>;
}

const RECORD_VERSION = /^niaro-meeting-record\/(\d{1,6})$/;
/**
 * A meeting record; one with a newer profile than this build knows is read
 * as the newest known one when its shape fits.
 */
export function parseMeetingRecord(value: unknown) {
  const newest = Number(RECORD_VERSION.exec(MEETING_RECORD_PROFILE)![1]);
  const version = isRecord(value)
    ? RECORD_VERSION.exec(String(value.profile))?.[1]
    : undefined;
  return parseServerValue(
    MeetingRecordSchema,
    version && Number(version) > newest
      ? { ...(value as object), profile: MEETING_RECORD_PROFILE }
      : value,
  );
}
